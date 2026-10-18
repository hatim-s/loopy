import type { NodeRun } from "./graph.js";
import type { Json, RunOutcome, RuntimeEventChange } from "./model.js";

export type StoreEffect =
  | { kind: "write_node_run"; nodeRun: NodeRun }
  | { kind: "finish_run"; outcome: RunOutcome; at: string }
  | { kind: "schedule_retry"; at: string }
  | { kind: "emit_event"; event: RuntimeEventChange };

export const MAX_OUTPUT_BYTES = 1024 * 1024;

export const MAX_LOG_BYTES = 64 * 1024;

export function outputBytes(output: Json): number {
  return new TextEncoder().encode(JSON.stringify(output)).byteLength;
}
