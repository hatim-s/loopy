import type { AttemptLog } from "./executor";
import type { ExecutionKey } from "./graph/key";
import type { NodeRun } from "./graph/node-run";
import type { OutSchema } from "./graph/values";
import type { Json } from "./json";
import type { RunOutcome } from "./model";

export type StoreEffect =
  | { kind: "write_node_run"; nodeRun: NodeRun }
  | { kind: "write_log"; executionKey: ExecutionKey; attempt: number; log: AttemptLog; at: string }
  | { kind: "finish_run"; outcome: RunOutcome; at: string }
  // Activate the run again at this time: a retry, a rate-limit window, a wait timeout or a sleep.
  | { kind: "schedule_activation"; at: string }
  | {
      kind: "register_wait";
      executionKey: ExecutionKey;
      name: string;
      payload: OutSchema;
      at: string;
    }
  | { kind: "suspend_run"; wakeAt: string | null };

export const MAX_OUTPUT_BYTES = 1024 * 1024;

export const MAX_LOG_BYTES = 64 * 1024;

// Views inline payloads up to this size and report only the byte count beyond it.
export const MAX_PREVIEW_BYTES = 16 * 1024;

export function outputBytes(output: Json): number {
  return new TextEncoder().encode(JSON.stringify(output)).byteLength;
}
