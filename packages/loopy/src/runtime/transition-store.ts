import type { TenantScope } from "../application/ports.js";
import type { AttemptRecord, RunRecord } from "../core/model.js";
import type { StartCommand, WorkspaceObservation } from "./remote-executor.js";

export type TransitionLease = { runId: string; token: string; fence: number; expiresAt: string };
export type DurableRunState = {
  revision: number;
  run: RunRecord;
  attempts: AttemptRecord[];
  intent?: StartCommand;
  workspace: WorkspaceObservation;
  cancelRequested: boolean;
};
/** Each operation is atomic. Commit rejects expired/stale leases or revisions.
 * Reclaiming a transition lease never declares a durable remote job dead.
 * Intent commits before start; release the lease while awaiting remote execution.
 */
export interface DurableRunRepository {
  readonly scope: TenantScope;
  read(runId: string): Promise<DurableRunState | undefined>;
  acquire(runId: string, token: string, ttlMs: number): Promise<TransitionLease | undefined>;
  commit(
    lease: TransitionLease,
    expectedRevision: number,
    state: DurableRunState,
  ): Promise<boolean>;
  release(lease: TransitionLease): Promise<void>;
  requestCancel(runId: string): Promise<void>;
}
