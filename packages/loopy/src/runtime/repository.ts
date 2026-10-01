import type { AttemptRecord, Json, RunEvent, RunRecord, RunStatus } from "../core/model.js";

/**
 * Durable run state shared by local and remote workers. Each mutation is atomic.
 * Implementations must fence writes by owner token. Distributed stores need a
 * bounded lease; a local store may use process liveness. Reclaiming a stopped
 * owner marks its running attempts uncertain before another attempt can start.
 * A cancelled attempt proves its command never launched and may be retried by
 * another initial delivery. A failed or uncertain attempt needs explicit resume.
 * Claiming a succeeded run returns it unchanged, even when deliveries race.
 * With resume disabled, all terminal runs return unchanged so a duplicate queue
 * message cannot replay a failed or interrupted run.
 */
export interface RunRepository {
  createRun(run: RunRecord): Promise<void>;
  getRun(id: string): Promise<RunRecord | undefined>;
  listRuns(slug?: string): Promise<RunRecord[]>;
  getAttempts(runId: string): Promise<AttemptRecord[]>;
  getEvents(runId: string, after?: number): Promise<RunEvent[]>;
  claim(runId: string, token: string, options?: { resume?: boolean }): Promise<RunRecord>;
  heartbeat(runId: string, token: string): Promise<boolean>;
  startAttempt(runId: string, token: string, nodeId: string, input: Json): Promise<AttemptRecord>;
  finishAttempt(
    runId: string,
    token: string,
    attemptId: string,
    status: Exclude<AttemptRecord["status"], "running">,
    output?: Json,
    error?: string,
  ): Promise<AttemptRecord>;
  finishRun(runId: string, token: string, status: RunStatus, error?: string): Promise<RunRecord>;
  release(runId: string, token: string): Promise<void>;
}
