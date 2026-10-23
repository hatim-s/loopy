import { durationMs, type Executor, type Graph, type Store } from "../core/index.js";
import type { Effect, EngineEvent } from "../engine/index.js";

type AdmissionOptions = {
  graph: Graph;
  store: Store;
  lookup: Executor["lookup"];
  at: string;
};

export async function acquireDispatch({
  graph,
  store,
  lookup,
  at,
  dispatch,
}: AdmissionOptions & {
  dispatch: Extract<Effect, { kind: "dispatch" }>;
}): Promise<Extract<EngineEvent, { kind: "rate_limited" }> | undefined> {
  const node = graph.nodes.find((node) => node.id === dispatch.executionKey.nodeId);

  if ((node?.kind !== "code" && node?.kind !== "command") || node.rateLimit === null) {
    return;
  }

  if ((await lookup(dispatch.executionKey, dispatch.attempt)).kind !== "none") {
    return;
  }

  const limit = node.rateLimit;

  const acquired = await store.acquireRateLimit(
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
    };
  }
}
