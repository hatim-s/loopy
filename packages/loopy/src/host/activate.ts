import {
  type Executor,
  errorMessage,
  type Graph,
  type RunOutcome,
  type Store,
} from "../core/index.js";
import { type EngineEvent, initialState, step } from "../engine/index.js";
import { planActivation } from "./activation-plan.js";
import { ActivationWork } from "./activation-work.js";
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

export type ActivationResult = RunOutcome | { status: "suspended" };

async function drive(options: ActivationOptions, token: string): Promise<ActivationResult> {
  const { store, graph, runId } = options;
  const clock = options.clock ?? SYSTEM_CLOCK;
  const run = await store.getRun(runId);

  if (!run) {
    throw new Error("Run disappeared before execution.");
  }

  let state = initialState(runId, run.input);
  let event: EngineEvent = { kind: "run_started", at: new Date(clock.now()).toISOString() };
  const work = new ActivationWork(options, clock);

  try {
    while (true) {
      work.signal.throwIfAborted();
      state = { ...state, nodeRuns: await store.getNodeRuns(runId) };

      const transition = step(graph, state, event);

      const plan = planActivation(transition);

      await store.apply({ runId, token, effects: plan.storeEffects });
      state = transition.state;

      if (plan.disposition.kind === "finished") {
        return plan.disposition.outcome;
      }

      if (plan.disposition.kind === "suspended") {
        return { status: "suspended" };
      }

      work.dispatch(plan.work);
      event = await work.next();
    }
  } finally {
    await work.close();
  }
}

export async function activate(options: ActivationOptions) {
  const token = crypto.randomUUID();
  await options.store.claim(options.runId, token);

  let outcome: { kind: "completed"; value: ActivationResult } | { kind: "failed"; cause: Error };

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
