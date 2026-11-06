import { durationMs, type ExecutionKey, type Graph, type Receipt, type Store } from "@loopy/core";
import type { Effect as EngineEffect } from "@loopy/core/engine";
import { Effect } from "effect";

type AdmissionOptions<E> = {
  graph: Graph;
  store: Store;
  lookup: (key: ExecutionKey, attempt: number) => Effect.Effect<Receipt, E>;
  at: string;
};

export function acquireDispatch<E>({
  graph,
  store,
  lookup,
  at,
  dispatch,
}: AdmissionOptions<E> & {
  dispatch: Extract<EngineEffect, { kind: "dispatch" }>;
}) {
  return Effect.gen(function* () {
    const node = graph.nodes.find((node) => node.id === dispatch.executionKey.nodeId);

    if ((node?.kind !== "code" && node?.kind !== "command") || node.rateLimit === null) {
      return;
    }

    if ((yield* lookup(dispatch.executionKey, dispatch.attempt)).kind !== "none") {
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
        kind: "rate_limited" as const,
        executionKey: dispatch.executionKey,
        attempt: dispatch.attempt,
        retryAt: acquired.retryAt,
        at,
      };
    }
  });
}
