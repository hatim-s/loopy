import { executionKeyString, type Graph, type Store } from "@loopy/core";
import type { EngineEffect } from "@loopy/core/engine";
import { Effect } from "effect";
import { completionEvent } from "../completion-event";
import { acquireDispatch } from "../rate-limit";
import { type DurableExecutionProvider, DurableProviderError } from ".";

export type DurableWork = Extract<EngineEffect, { kind: "dispatch" | "sample" }>;

export function durableWorkId(work: DurableWork): string {
  return `${executionKeyString(work.executionKey)}/${work.kind === "dispatch" ? work.attempt : "sample"}`;
}

export function reconcileDurableWork(options: {
  store: Store;
  graph: Graph;
  runId: string;
  token: string;
  provider: DurableExecutionProvider;
  work: DurableWork;
  at: string;
}) {
  return Effect.gen(function* () {
    const { store, graph, runId, token, provider, work, at } = options;

    if (work.kind === "sample") {
      return {
        kind: "value_sampled" as const,
        executionKey: work.executionKey,
        sample:
          work.valueKind === "uuid"
            ? { valueKind: "uuid" as const, value: crypto.randomUUID() }
            : { valueKind: "random" as const, value: Math.random() },
        at,
      };
    }

    const previous = yield* store.getNodeRun(work.executionKey);

    if (previous?.status !== "running" || previous.attempt !== work.attempt) {
      return;
    }

    let receipt = yield* provider.lookup(work.executionKey, work.attempt);

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
      const denial = yield* acquireDispatch({
        graph,
        store,
        lookup: () => Effect.succeed(receipt),
        dispatch: work,
        at,
      });

      if (denial) {
        return denial;
      }

      receipt = yield* provider.start(work.executionKey, work.attempt, work.spec);

      if (receipt.kind === "none") {
        return yield* Effect.fail(
          new DurableProviderError({
            operation: "start",
            reason: "protocol",
            message:
              "Execution provider did not persist a receipt. Restore the provider before resuming.",
            cause: receipt,
          }),
        );
      }
    }

    if (receipt.kind === "finished") {
      return completionEvent(work, receipt.result, at);
    }

    if (previous.receipt !== "started") {
      yield* store.apply({
        runId,
        token,
        effects: [{ kind: "write_node_run", nodeRun: { ...previous, receipt: "started" } }],
      });
    }
  });
}
