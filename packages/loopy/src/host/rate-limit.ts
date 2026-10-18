import { durationMs, type Executor, type Graph, type Store } from "../core/index.js";
import { step } from "../engine/index.js";

type Transition = ReturnType<typeof step>;

export async function acquireDispatch({
  graph,
  store,
  executor,
  transition,
  at,
}: {
  graph: Graph;
  store: Store;
  executor: Executor;
  transition: Transition;
  at: string;
}): Promise<Transition> {
  const candidate = transition.effects.find((effect) => effect.kind === "dispatch");

  if (candidate?.kind !== "dispatch") {
    return transition;
  }

  const node = graph.nodes.find((node) => node.id === candidate.executionKey.nodeId);

  if ((node?.kind !== "code" && node?.kind !== "command") || node.rateLimit === null) {
    return transition;
  }

  const receipt = await executor.lookup(candidate.executionKey, candidate.attempt);

  if (receipt.kind !== "none") {
    return transition;
  }

  const limit = node.rateLimit;

  const acquired = await store.acquireRateLimit(
    limit.key,
    limit.limit,
    durationMs(limit.window),
    at,
  );

  if (acquired.ok) {
    return transition;
  }

  const limited = step(graph, transition.state, {
    kind: "rate_limited",
    executionKey: candidate.executionKey,
    attempt: candidate.attempt,
    retryAt: acquired.retryAt,
    at,
  });

  return {
    state: limited.state,
    effects: [
      ...transition.effects.filter((effect) => effect.kind !== "dispatch"),
      ...limited.effects,
    ],
  };
}
