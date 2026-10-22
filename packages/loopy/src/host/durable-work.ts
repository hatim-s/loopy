import {
  type Executor,
  executionKeyString,
  type Graph,
  type Receipt,
  type Store,
} from "../core/index.js";
import type { Effect, EngineEvent, EngineState } from "../engine/index.js";
import type { DurableExecutionProvider } from "./durable.js";
import { acquireDispatch } from "./rate-limit.js";

export type DurableWork = Extract<Effect, { kind: "dispatch" | "sample" }>;

export function durableWorkId(work: DurableWork): string {
  return `${executionKeyString(work.executionKey)}/${work.kind === "dispatch" ? work.attempt : "sample"}`;
}

function completed(
  work: Extract<DurableWork, { kind: "dispatch" }>,
  receipt: Extract<Receipt, { kind: "finished" }>,
  at: string,
): EngineEvent {
  const base = { executionKey: work.executionKey, attempt: work.attempt, at };
  const { result } = receipt;

  return result.kind === "succeeded"
    ? { ...base, kind: "execution_completed", result }
    : {
        ...base,
        kind: "execution_failed",
        error: result.error,
        exitCode: result.exitCode,
        logs: result.logs,
      };
}

export async function reconcileDurableWork(options: {
  store: Store;
  graph: Graph;
  runId: string;
  token: string;
  provider: DurableExecutionProvider;
  work: DurableWork;
  state: EngineState;
  at: string;
}): Promise<EngineEvent | undefined> {
  const { store, graph, runId, token, provider, work, state, at } = options;

  if (work.kind === "sample") {
    return {
      kind: "value_sampled",
      executionKey: work.executionKey,
      value: work.valueKind === "uuid" ? crypto.randomUUID() : Math.random(),
      at,
    };
  }

  const previous = state.nodeRuns.find(
    (node) => executionKeyString(node.key) === executionKeyString(work.executionKey),
  );

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
    // acquireDispatch only needs lookup. Execution belongs to the asynchronous provider.
    const executor: Executor = {
      lookup: async () => receipt,
      execute: async () => {
        throw new Error("Durable dispatch cannot wait for execution. Use provider.start.");
      },
    };

    const limited = await acquireDispatch({
      graph,
      store,
      executor,
      transition: { state, effects: [work] },
      at,
      inFlight: new Set(),
    });

    await store.apply({
      runId,
      token,
      effects: limited.effects.filter(
        (effect) => effect.kind !== "dispatch" && effect.kind !== "sample",
      ),
    });

    if (!limited.effects.some((effect) => effect.kind === "dispatch")) {
      return;
    }

    receipt = await provider.start(work.executionKey, work.attempt, work.spec);

    if (receipt.kind === "none") {
      throw new Error(
        "Execution provider did not persist a receipt. Restore the provider before resuming.",
      );
    }
  }

  if (receipt.kind === "finished") {
    return completed(work, receipt, at);
  }

  await store.apply({
    runId,
    token,
    effects: [{ kind: "write_node_run", nodeRun: { ...previous, receipt: "started" } }],
  });
}
