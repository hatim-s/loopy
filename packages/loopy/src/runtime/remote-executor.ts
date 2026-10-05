export const MAX_EXECUTION_OUTPUT_BYTES = 1_048_576;
export const MAX_EXECUTION_METADATA_BYTES = 512_000;

import type { CommandOutput, ResolvedCommand } from "../core/model.js";

export type ExecutionKey = { tenantId: string; runId: string; attemptId: string };
export type WorkspaceGeneration = { workspaceId: string; generation: string };
export type WorkspaceObservation =
  | { state: "unallocated" }
  | { state: "available"; workspace: WorkspaceGeneration }
  | { state: "lost"; workspace: WorkspaceGeneration; reason: string };
export type StartCommand = {
  key: ExecutionKey;
  fingerprint: string;
  command: ResolvedCommand;
  workspace: WorkspaceGeneration;
  deadline: string;
};
export type ExecutionObservation =
  | { state: "not-started" }
  | { state: "running"; jobId: string; workspace: WorkspaceGeneration }
  | { state: "completed"; jobId: string; output: CommandOutput; workspace: WorkspaceGeneration }
  | { state: "cancelled-before-start" }
  | { state: "unknown"; reason: string };
export type StartReceipt = Exclude<ExecutionObservation, { state: "not-started" }>;
export type CancelReceipt = ExecutionObservation;

/** Keys survive coordinator leases. Same key and fingerprint returns the original job.
 * A changed fingerprint conflicts. Lost acknowledgements require inspect, never a new key.
 * Unknown means the command may have run and requires an explicit retry decision.
 */
export interface RemoteExecutor {
  /** Supported aggregate UTF-8 stdout and stderr capacity, known before admission. */
  readonly maxOutputBytes: number;
  start(request: StartCommand): Promise<StartReceipt>;
  inspect(key: ExecutionKey): Promise<ExecutionObservation>;
  cancel(key: ExecutionKey): Promise<CancelReceipt>;
}
