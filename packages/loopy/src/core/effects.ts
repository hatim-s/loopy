import type { AttemptLog } from "./executor.js";
import type { Json, RunOutcome } from "./model.js";
import type { ExecutionKey, NodeRun } from "./node-run.js";

export type StoreEffect =
  | { kind: "write_node_run"; nodeRun: NodeRun }
  | { kind: "write_log"; executionKey: ExecutionKey; attempt: number; log: AttemptLog; at: string }
  | { kind: "finish_run"; outcome: RunOutcome; at: string }
  | { kind: "schedule_retry"; at: string };

export const MAX_OUTPUT_BYTES = 1024 * 1024;

export const MAX_LOG_BYTES = 64 * 1024;

export function outputBytes(output: Json): number {
  return new TextEncoder().encode(JSON.stringify(output)).byteLength;
}
