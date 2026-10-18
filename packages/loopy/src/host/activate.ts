import {
  type ExecutionResult,
  type Executor,
  errorMessage,
  type Graph,
  type RunOutcome,
  type Store,
  type StoreEffect,
} from "../core/index.js";
import { type Effect, type EngineEvent, initialState, step } from "../engine/index.js";
import { type Clock, SYSTEM_CLOCK } from "./clock.js";
import { withHeartbeat } from "./heartbeat.js";
import { acquireDispatch } from "./rate-limit.js";

export type ActivationOptions = {
  store: Store;
  executor: Executor;
  runId: string;
  graph: Graph;
  clock?: Clock;
  signal?: AbortSignal;
};

function completionEvent(
  dispatch: Extract<Effect, { kind: "dispatch" }>,
  result: ExecutionResult,
  at: string,
): EngineEvent {
  const base = { executionKey: dispatch.executionKey, attempt: dispatch.attempt, at };

  return result.kind === "failed"
    ? {
        ...base,
        kind: "execution_failed",
        error: result.error,
        exitCode: result.exitCode,
        logs: result.logs,
      }
    : { ...base, kind: "execution_completed", result };
}

async function execute(
  options: ActivationOptions,
  dispatch: Extract<Effect, { kind: "dispatch" }>,
  signal: AbortSignal,
): Promise<ExecutionResult> {
  const { executor, store, runId } = options;

  while (true) {
    const receipt = await executor.lookup(dispatch.executionKey, dispatch.attempt);

    if (receipt.kind === "finished") {
      return receipt.result;
    }

    if (receipt.kind === "none") {
      return executor.execute(dispatch.executionKey, dispatch.attempt, dispatch.spec, signal);
    }

    // A started receipt is uncertain. Keep reconciling while the executor owns the attempt.
    if (signal.aborted) {
      throw new Error("Execution reconciliation interrupted. Resume the run.");
    }

    if (!(await store.getRun(runId))?.owner) {
      throw new Error("Run lost ownership during reconciliation.");
    }

    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
}

async function waitForRetry(clock: Clock, at: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const cancel = clock.timeout(finish, Math.max(0, Date.parse(at) - clock.now()));

    function finish() {
      signal.removeEventListener("abort", abort);
      resolve();
    }

    function abort() {
      cancel();
      reject(new Error("Retry interrupted. Resume the run."));
    }

    signal.addEventListener("abort", abort, { once: true });
  });
}

async function drive(options: ActivationOptions, token: string) {
  const { store, graph, runId } = options;
  const clock = options.clock ?? SYSTEM_CLOCK;
  const run = await store.getRun(runId);

  if (!run) {
    throw new Error("Run disappeared before execution.");
  }

  let state = initialState(runId, run.input, await store.getNodeRuns(runId));
  let event: EngineEvent = { kind: "run_started", at: new Date(clock.now()).toISOString() };
  const signal = options.signal ?? new AbortController().signal;

  while (true) {
    const transition = await acquireDispatch({
      ...options,
      transition: step(graph, state, event),
      at: event.at,
    });

    const durable = transition.effects.filter(
      (effect): effect is StoreEffect => effect.kind !== "dispatch",
    );

    await store.apply({ runId, token, effects: durable });
    state = transition.state;

    if (state.phase.kind === "finished") {
      return state.phase.outcome;
    }

    const retry = transition.effects.find((effect) => effect.kind === "schedule_retry");

    if (retry?.kind === "schedule_retry") {
      await waitForRetry(clock, retry.at, signal);
      event = { kind: "retry_due", at: new Date(clock.now()).toISOString() };
      continue;
    }

    const dispatch = transition.effects.find((effect) => effect.kind === "dispatch");

    if (dispatch?.kind !== "dispatch") {
      throw new Error("Active run has no pending execution.");
    }

    const result = await execute(options, dispatch, signal);
    event = completionEvent(dispatch, result, new Date(clock.now()).toISOString());
  }
}

export async function activate(options: ActivationOptions) {
  const token = crypto.randomUUID();
  await options.store.claim(options.runId, token);

  let outcome: { kind: "completed"; value: RunOutcome } | { kind: "failed"; cause: Error };

  try {
    outcome = {
      kind: "completed",
      value: await withHeartbeat(options.store, options.runId, token, () => drive(options, token)),
    };
  } catch (cause) {
    outcome = {
      kind: "failed",
      cause: cause instanceof Error ? cause : new Error(errorMessage(cause)),
    };
  }

  try {
    await options.store.release(options.runId, token);
  } catch (cause) {
    if (outcome.kind === "failed") {
      throw new Error(errorMessage(outcome.cause), { cause });
    }

    if (outcome.value.status === "failed") {
      throw new Error(outcome.value.error, { cause });
    }

    throw cause;
  }

  if (outcome.kind === "failed") {
    throw outcome.cause;
  }

  return outcome.value;
}
