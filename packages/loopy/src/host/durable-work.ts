import { executionKeyString, type Graph, type Store } from "../core/index.js";
import type { Effect, EngineEvent } from "../engine/index.js";
import { completionEvent } from "./completion-event.js";
import type { DurableExecutionProvider } from "./durable.js";
import { acquireDispatch } from "./rate-limit.js";

export type DurableWork = Extract<Effect, { kind: "dispatch" | "sample" }>;

export function durableWorkId(work: DurableWork): string {
  return `${executionKeyString(work.executionKey)}/${work.kind === "dispatch" ? work.attempt : "sample"}`;
}

export async function reconcileDurableWork(options: {
  store: Store;
  graph: Graph;
  runId: string;
  token: string;
  provider: DurableExecutionProvider;
  work: DurableWork;
  at: string;
}): Promise<EngineEvent | undefined> {
  const { store, graph, runId, token, provider, work, at } = options;

  if (work.kind === "sample") {
    return {
      kind: "value_sampled",
      executionKey: work.executionKey,
      value: work.valueKind === "uuid" ? crypto.randomUUID() : Math.random(),
      at,
    };
  }

  const previous = await store.getNodeRun(work.executionKey);

  if (previous?.status !== "running" || previous.attempt !== work.attempt) {
    return;
  }

  let receipt = await provider.lookup(work.executionKey, work.attempt);

  if (receipt.kind === "none" && previous.receipt === "started") {
    receipt = {
      kind: "finished",
      result: {
        kind: "failed",
        error: {
          code: "uncertain",
          message: "Started execution disappeared. Inspect its effects before retrying.",
        },
        exitCode: null,
        logs: [],
      },
    };
  }

  if (receipt.kind === "none") {
    const denial = await acquireDispatch({
      graph,
      store,
      lookup: async () => receipt,
      dispatch: work,
      at,
    });

    if (denial) {
      return denial;
    }

    receipt = await provider.start(work.executionKey, work.attempt, work.spec);

    if (receipt.kind === "none") {
      throw new Error(
        "Execution provider did not persist a receipt. Restore the provider before resuming.",
      );
    }
  }

  if (receipt.kind === "finished") {
    return completionEvent(work, receipt.result, at);
  }

  if (previous.receipt !== "started") {
    await store.apply({
      runId,
      token,
      effects: [{ kind: "write_node_run", nodeRun: { ...previous, receipt: "started" } }],
    });
  }
}
