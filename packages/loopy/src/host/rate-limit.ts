import {
  durationMs,
  type Executor,
  executionKeyString,
  type Graph,
  type Store,
} from "../core/index.js";
import { step } from "../engine/index.js";

type Transition = ReturnType<typeof step>;

export async function acquireDispatch({
  graph,
  store,
  executor,
  transition,
  at,
  inFlight,
}: {
  graph: Graph;
  store: Store;
  executor: Executor;
  transition: Transition;
  at: string;
  inFlight: ReadonlySet<string>;
}): Promise<Transition> {
  const checked = new Set(inFlight);
  let current = transition;

  while (true) {
    const candidate = current.effects.find(
      (effect) =>
        effect.kind === "dispatch" &&
        !checked.has(`${executionKeyString(effect.executionKey)}/${effect.attempt}`),
    );

    if (candidate?.kind !== "dispatch") {
      return current;
    }

    checked.add(`${executionKeyString(candidate.executionKey)}/${candidate.attempt}`);
    const node = graph.nodes.find((node) => node.id === candidate.executionKey.nodeId);

    if ((node?.kind !== "code" && node?.kind !== "command") || node.rateLimit === null) {
      continue;
    }

    const receipt = await executor.lookup(candidate.executionKey, candidate.attempt);

    if (receipt.kind !== "none") {
      continue;
    }

    const limit = node.rateLimit;

    const acquired = await store.acquireRateLimit(
      limit.key,
      limit.limit,
      durationMs(limit.window),
      at,
    );

    if (acquired.ok) {
      continue;
    }

    const limited = step(graph, current.state, {
      kind: "rate_limited",
      executionKey: candidate.executionKey,
      attempt: candidate.attempt,
      retryAt: acquired.retryAt,
      at,
    });

    current = {
      state: limited.state,
      effects: [...current.effects.filter((effect) => effect !== candidate), ...limited.effects],
    };
  }
}
