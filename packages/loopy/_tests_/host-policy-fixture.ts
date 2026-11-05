import { Effect } from "effect";
import type { ExecutionKey, ExecutionResult, Receipt } from "../src/core/index.js";
import { executionKeyString } from "../src/core/index.js";
import type { DurableExecutionProvider } from "../src/host/durable.js";
import { code, loopy, parallel, wait } from "../src/sdk/graph/index.js";

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
  }).graph;

  for (const node of graph.nodes) {
    if (node.kind === "code") {
      node.module.bundleHash = "a".repeat(64);
    }
  }

  return graph;
}

export class PolicyProvider implements DurableExecutionProvider {
  receipts = new Map<string, Receipt>();
  starts: { key: ExecutionKey; attempt: number }[] = [];
  lookups: string[] = [];

  id(key: ExecutionKey, attempt: number) {
    return `${executionKeyString(key)}/${attempt}`;
  }

  lookup(key: ExecutionKey, attempt: number) {
    return Effect.gen({ self: this }, function* () {
      this.lookups.push(this.id(key, attempt));

      return this.receipts.get(this.id(key, attempt)) ?? { kind: "none" as const };
    });
  }

  start(key: ExecutionKey, attempt: number): Effect.Effect<Receipt> {
    return Effect.gen({ self: this }, function* () {
      this.starts.push({ key, attempt });
      this.receipts.set(this.id(key, attempt), { kind: "started" as const });

      return { kind: "started" as const };
    });
  }
}
