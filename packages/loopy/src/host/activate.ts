import {
  type Executor,
  errorMessage,
  type Graph,
  type RunOutcome,
  type Store,
  type StoreEffect,
} from "../core/index.js";
import { type EngineEvent, initialState, step } from "../engine/index.js";
import { ActivationWork } from "./activation-work.js";
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

export type ActivationResult = RunOutcome | { status: "suspended" };

async function drive(options: ActivationOptions, token: string): Promise<ActivationResult> {
  const { store, graph, runId } = options;
  const clock = options.clock ?? SYSTEM_CLOCK;
  const run = await store.getRun(runId);

  if (!run) {
    throw new Error("Run disappeared before execution.");
  }

  let state = initialState(runId, run.input, await store.getNodeRuns(runId));
  let event: EngineEvent = { kind: "run_started", at: new Date(clock.now()).toISOString() };
  const work = new ActivationWork(options, clock);

  try {
    while (true) {
      work.signal.throwIfAborted();
      state = { ...state, nodeRuns: await store.getNodeRuns(runId) };

      const transition = await acquireDispatch({
        ...options,
        transition: step(graph, state, event),
        at: event.at,
        inFlight: work.inFlight,
      });

      const durable = transition.effects.filter(
        (effect): effect is StoreEffect => effect.kind !== "dispatch" && effect.kind !== "sample",
      );

      await store.apply({ runId, token, effects: durable });
      state = transition.state;

      if (state.phase.kind === "finished") {
        return state.phase.outcome;
      }

      if (durable.some((effect) => effect.kind === "suspend_run")) {
        return { status: "suspended" };
      }

      work.dispatch(transition.effects);
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
