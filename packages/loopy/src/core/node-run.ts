import type { ExecutionError } from "./executor.js";
import type { NodeId } from "./graph.js";
import type { Json } from "./model.js";

type Expand<T> = T extends unknown ? { [K in keyof T]: T[K] } : never;

export type ExecutionKey = {
  runId: string;
  nodeId: NodeId;
  scope: { nodeId: NodeId; index: number }[];
};

export function executionKeyString(key: ExecutionKey): string {
  // JSON-quoted run/node ids and scope tuples are joined by '/'. Quoting keeps ids
  // unambiguous so stores and wire consumers share one execution identity.
  return [
    JSON.stringify(key.runId),
    JSON.stringify(key.nodeId),
    ...key.scope.map(({ nodeId, index }) => JSON.stringify([nodeId, index])),
  ].join("/");
}

export const NODE_RUN_STATUSES = [
  "running",
  "succeeded",
  "failed",
  "retrying",
  "waiting",
  "sleeping",
  "cancelled",
  "rate_limited",
] as const;

export const RECEIPT_KINDS = ["none", "started", "finished"] as const;

export type NodeRun = Expand<
  {
    key: ExecutionKey;
    attempt: number;
    maxAttempts: number;
    startedAt: string;
    receipt: (typeof RECEIPT_KINDS)[number];
  } & (
    | { status: "running" }
    | { status: "rate_limited"; nextRetryAt: string }
    | { status: "succeeded"; output: Json; endedAt: string }
    | { status: "failed"; error: ExecutionError; endedAt: string }
    | {
        status: "retrying";
        error: ExecutionError;
        nextRetryAt: string;
        endedAt: string;
      }
    | { status: "waiting"; wakeAt: string | null }
    | { status: "sleeping"; wakeAt: string }
    | { status: "cancelled"; endedAt: string }
  )
>;

export function sameExecution(left: ExecutionKey, right: ExecutionKey): boolean {
  return executionKeyString(left) === executionKeyString(right);
}
