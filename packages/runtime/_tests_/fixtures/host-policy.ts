import type { ExecutionKey, ExecutionResult, Receipt } from "@loopy/core";
import { executionKeyString } from "@loopy/core";
import { code, loopy, parallel, wait } from "@loopy/sdk/graph";
import { Deferred, Effect } from "effect";
import type { DurableExecutionProvider, DurableProviderError } from "../../src/host";
import { withBundles } from "./compiled";
import { MemorySqlStore } from "./stores";

export const policySuccess: ExecutionResult = {
  kind: "succeeded",
  output: 42,
  logs: [{ message: "success", data: null }],
};

export const policyRetry: ExecutionResult = {
  kind: "failed",
  error: { code: "execution", message: "temporary" },
  exitCode: null,
  logs: [{ message: "retry", data: null }],
};

export function policyWork() {
  return code("work", {
    in: {},
    out: { kind: "value", type: "number" },
    module: "./work.ts",
    retry: { attempts: 2 },
  });
}

export function policyGraph() {
  const graph = loopy("policy", {
    input: {},
    run: () =>
      parallel({
        work: policyWork,
        approval: () => wait("approve", { payload: { kind: "value", type: "boolean" } }),
      }),
  });

  withBundles(graph);

  return graph;
}

/** Records every lookup and start; each start returns `result` until a test finishes it. */
export class PolicyProvider implements DurableExecutionProvider {
  receipts = new Map<string, Receipt>();
  starts: { key: ExecutionKey; attempt: number }[] = [];
  lookups: string[] = [];
  result: Receipt = { kind: "started" };

  id(key: ExecutionKey, attempt: number) {
    return `${executionKeyString(key)}/${attempt}`;
  }

  lookup(key: ExecutionKey, attempt: number): Effect.Effect<Receipt, DurableProviderError> {
    return Effect.sync(() => {
      this.lookups.push(this.id(key, attempt));

      return this.receipts.get(this.id(key, attempt)) ?? { kind: "none" as const };
    });
  }

  start(key: ExecutionKey, attempt: number): Effect.Effect<Receipt, DurableProviderError> {
    return Effect.sync(() => {
      this.starts.push({ key, attempt });
      this.receipts.set(this.id(key, attempt), this.result);

      return this.result;
    });
  }

  /** Finishes the latest start. */
  finish(result: ExecutionResult = policySuccess) {
    const started = this.starts.at(-1);

    if (!started) {
      throw new Error("Expected a started execution.");
    }

    this.receipts.set(this.id(started.key, started.attempt), { kind: "finished", result });
  }

  finishAll(result: ExecutionResult = policySuccess) {
    for (const started of this.starts) {
      this.receipts.set(this.id(started.key, started.attempt), { kind: "finished", result });
    }
  }
}

/** Completes `retried` once a committed batch writes a retrying or rate-limited node. */
export class RetryGateStore extends MemorySqlStore {
  constructor(
    private readonly retried: Deferred.Deferred<void>,
    options: { leaseMs?: number } = {},
  ) {
    super(options);
  }

  override apply(batch: Parameters<MemorySqlStore["apply"]>[0]) {
    return super
      .apply(batch)
      .pipe(
        Effect.tap(() =>
          batch.effects.some(
            (effect) =>
              effect.kind === "write_node_run" &&
              (effect.nodeRun.status === "retrying" || effect.nodeRun.status === "rate_limited"),
          )
            ? Deferred.succeed(this.retried, undefined)
            : Effect.void,
        ),
      );
  }
}
