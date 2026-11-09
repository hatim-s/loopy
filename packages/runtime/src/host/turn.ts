import {
  durationMs,
  type ExecutionResult,
  executionKeyString,
  type Graph,
  type Json,
  type RunOutcome,
  type Store,
  type StoreEffect,
} from "@loopy/core";
import { type EngineEffect, type EngineEvent, initialState, step } from "@loopy/core/engine";
import { Effect } from "effect";

export type Dispatch = Extract<EngineEffect, { kind: "dispatch" }>;

export type HostWork = Extract<EngineEffect, { kind: "dispatch" | "sample" }>;

export type TurnDisposition =
  | { kind: "active" }
  | { kind: "suspended" }
  | { kind: "finished"; outcome: RunOutcome };

export type TurnOptions = {
  store: Store;
  graph: Graph;
  runId: string;
  token: string;
  input: Json;
};

/** Rebuilds state from persisted node runs, steps once and commits every store effect before any work starts. */
export function commitTurn(options: TurnOptions, event: EngineEvent) {
  return Effect.gen(function* () {
    const { store, graph, runId, token, input } = options;

    const transition = step(
      graph,
      initialState(runId, input, yield* store.getNodeRuns(runId)),
      event,
    );

    const effects: StoreEffect[] = [];
    const work: HostWork[] = [];
    let retryAt: string | null = null;

    for (const effect of transition.effects) {
      if (effect.kind === "dispatch" || effect.kind === "sample") {
        work.push(effect);
        continue;
      }

      effects.push(effect);

      if (effect.kind === "schedule_activation" && (retryAt === null || effect.at < retryAt)) {
        retryAt = effect.at;
      }
    }

    yield* store.apply({ runId, token, effects });

    const disposition: TurnDisposition =
      transition.state.phase.kind === "finished"
        ? transition.state.phase
        : effects.some((effect) => effect.kind === "suspend_run")
          ? { kind: "suspended" }
          : { kind: "active" };

    return { disposition, work, retryAt };
  });
}

export function workId(work: HostWork): string {
  return `${executionKeyString(work.executionKey)}/${work.kind === "dispatch" ? work.attempt : "sample"}`;
}

export function sampleEvent(work: Extract<HostWork, { kind: "sample" }>, at: string): EngineEvent {
  return {
    kind: "value_sampled",
    executionKey: work.executionKey,
    sample:
      work.valueKind === "uuid"
        ? { valueKind: "uuid", value: crypto.randomUUID() }
        : { valueKind: "random", value: Math.random() },
    at,
  };
}

export function completionEvent(
  dispatch: Dispatch,
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

/** Admits a dispatch that has no receipt yet. Rate admission follows persistence and never repeats started work. */
export function admitDispatch(options: {
  graph: Graph;
  store: Store;
  dispatch: Dispatch;
  at: string;
}) {
  return Effect.gen(function* () {
    const { graph, store, dispatch, at } = options;
    const node = graph.nodes.find((node) => node.id === dispatch.executionKey.nodeId);

    if ((node?.kind !== "code" && node?.kind !== "command") || node.rateLimit === null) {
      return;
    }

    const limit = node.rateLimit;

    const acquired = yield* store.acquireRateLimit(
      limit.key,
      limit.limit,
      durationMs(limit.window),
      at,
    );

    if (!acquired.ok) {
      return {
        kind: "rate_limited",
        executionKey: dispatch.executionKey,
        attempt: dispatch.attempt,
        retryAt: acquired.retryAt,
        at,
      } satisfies EngineEvent;
    }
  });
}
