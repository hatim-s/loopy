import {
  type Executor,
  errorMessage,
  type Graph,
  type RunOutcome,
  type Store,
  toError,
} from "../core/index.js";
import { type EngineEvent, initialState, step, type Transition } from "../engine/index.js";
import { type Clock, SYSTEM_CLOCK } from "./clock.js";
import { withHeartbeat } from "./heartbeat.js";

export type ActivationOptions = {
  store: Store;
  executor: Executor;
  runId: string;
  graph: Graph;
  clock?: Clock;
  signal?: AbortSignal;
};

async function execute(
  options: ActivationOptions,
  dispatch: Extract<Transition["next"], { kind: "dispatch" }>,
  signal: AbortSignal,
): Promise<EngineEvent> {
  const { executor, store, runId, graph } = options;
  const clock = options.clock ?? SYSTEM_CLOCK;
  const node = graph.nodes.find((node) => node.id === dispatch.executionKey.nodeId);
  const rule = node?.kind === "code" || node?.kind === "command" ? node.rateLimit : null;

  while (true) {
    const receipt = await executor.lookup(dispatch.executionKey, dispatch.attempt);
    const at = new Date(clock.now()).toISOString();
    const identity = { executionKey: dispatch.executionKey, attempt: dispatch.attempt, at };

    if (receipt.kind === "finished") {
      return { ...identity, kind: "execution_finished", result: receipt.result };
    }

    if (receipt.kind === "none") {
      if (rule) {
        const acquired = await store.acquireRateLimit(rule, at);

        if (!acquired.ok) {
          return { ...identity, kind: "rate_limited", retryAt: acquired.retryAt };
        }
      }

      const result = await executor.execute(
        dispatch.executionKey,
        dispatch.attempt,
        dispatch.spec,
        signal,
      );

      return {
        ...identity,
        kind: "execution_finished",
        at: new Date(clock.now()).toISOString(),
        result,
      };
    }

    signal.throwIfAborted();

    if (!(await store.getRun(runId))?.owner) {
      throw new Error("Run lost ownership during reconciliation.");
    }

    await waitForRetry(clock, new Date(clock.now() + 100).toISOString(), signal);
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
  let event: EngineEvent = { kind: "resume", at: new Date(clock.now()).toISOString() };
  const signal = options.signal ?? new AbortController().signal;

  while (true) {
    const transition = step(graph, state, event);
    await store.apply({ runId, token, effects: transition.writes });
    state = transition.state;

    switch (transition.next.kind) {
      case "finished":
        return transition.next.outcome;
      case "wait":
        await waitForRetry(clock, transition.next.at, signal);
        event = { kind: "resume", at: new Date(clock.now()).toISOString() };
        break;
      case "dispatch":
        event = await execute(options, transition.next, signal);
        break;
    }
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
      cause: toError(cause),
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
