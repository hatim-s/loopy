import type { AttemptLog } from "./executor";
import type { ExecutionKey } from "./graph/key";
import type { NodeRun } from "./graph/node-run";
import type { OutSchema } from "./graph/values";
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
