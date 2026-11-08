import {
  isTerminalRun,
  OwnershipError,
  type RunOutcome,
  type RunRecord,
  type RuntimeEvent,
  type WakeError,
} from "@loopy/core";
import { StoreRejectedError } from "../operation";
import { acquireWindow, type RateLimitWindow } from "../rate-limit-window";
import { normalizeRun, utc } from "../timestamps";
import type { SqlContext, SqlWrite } from "./context";
import { emit } from "./events";
import { type RunRow, rowToRun } from "./rows";

const RELEASE =
  "UPDATE runs SET wake_at=CASE WHEN status='running' THEN ? ELSE wake_at END,status=CASE WHEN status='running' THEN 'suspended' ELSE status END,owner_token=NULL,owner_pid=NULL,owner_host=NULL,heartbeat_at=NULL,updated_at=? WHERE id=? AND owner_token=?";

const WAKE = "UPDATE runs SET wake_at=?,updated_at=? WHERE id=?";

export function readRun(ctx: SqlContext, runId: string): RunRow | undefined {
  return ctx.db.query<RunRow, [string]>("SELECT * FROM runs WHERE id=?").get(runId) ?? undefined;
}

export function requireRun(ctx: SqlContext, runId: string): RunRow {
  const row = readRun(ctx, runId);

  if (!row) {
    throw new StoreRejectedError(`Run '${runId}' does not exist. Create the run first.`);
  }

  return row;
}

export function requireRunning(ctx: SqlContext, runId: string, token: string): RunRow {
  const row = requireRun(ctx, runId);

  if (row.owner_token !== token) {
    throw new OwnershipError(runId);
  }

  if (row.status !== "running") {
    throw new StoreRejectedError(
      `Run '${row.id}' cannot transition from '${row.status}'. Claim a queued or suspended run first.`,
    );
  }

  return row;
}

export function isStale(ctx: SqlContext, row: RunRow, now: number): boolean {
  if (
    (row.status !== "running" && row.status !== "suspended") ||
    row.owner_token === null ||
    row.heartbeat_at === null
  ) {
    return false;
  }

  if (row.owner_host !== null && ctx.owner.isAlive({ host: row.owner_host, pid: row.owner_pid })) {
    return false;
  }

  return now - Date.parse(row.heartbeat_at) > ctx.leaseMs;
}

export function emitRun(
  write: SqlWrite,
  runId: string,
  kind: Extract<RuntimeEvent, { entity: "run" }>["kind"],
): void {
  emit(write, { entity: "run", kind, runId, record: rowToRun(requireRun(write, runId)) });
}

export function insertRun(write: SqlWrite, input: RunRecord): void {
  if (readRun(write, input.id)) {
    throw new StoreRejectedError(`Run '${input.id}' already exists. Use a new run ID.`);
  }

  const run = normalizeRun(input);

  write.db
    .query(
      "INSERT INTO runs(id,slug,revision,workspace,input_json,status,output_json,error,wake_at,next_retry_at,created_at,updated_at,owner_token,owner_pid,owner_host,heartbeat_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    )
    .run(
      run.id,
      run.slug,
      run.revision,
      run.workspace,
      JSON.stringify(run.input),
      run.status,
      run.status === "succeeded" ? JSON.stringify(run.output) : null,
      run.status === "failed" ? run.error : null,
      run.status === "suspended" ? run.wakeAt : null,
      run.nextRetryAt ?? null,
      run.createdAt,
      run.updatedAt,
      run.owner?.token ?? null,
      run.owner?.pid ?? null,
      run.owner?.host ?? null,
      run.owner?.heartbeatAt ?? null,
    );
  emitRun(write, run.id, "created");
}

// Releasing a running owner suspends the run, due now, whether the owner left or went stale.
function releaseOwner(write: SqlWrite, previous: RunRow): void {
  write.db.query(RELEASE).run(write.at, write.at, previous.id, previous.owner_token);
  emitRun(write, previous.id, "released");

  if (previous.status === "running") {
    emitRun(write, previous.id, "suspended");
  }
}

export function claimRun(write: SqlWrite, runId: string, token: string): RunRecord {
  const previous = requireRun(write, runId);

  if (isStale(write, previous, write.now)) {
    releaseOwner(write, previous);
  }

  const claimed = write.db
    .query(
      "UPDATE runs SET owner_token=?,owner_pid=?,owner_host=?,heartbeat_at=?,updated_at=?,status='running',wake_at=NULL,next_retry_at=NULL WHERE id=? AND owner_token IS NULL AND status IN ('queued','suspended','running')",
    )
    .run(token, write.owner.identity.pid, write.owner.identity.host, write.at, write.at, runId);

  if (claimed.changes !== 1) {
    const row = requireRun(write, runId);

    if (row.owner_token !== null) {
      throw new OwnershipError(runId);
    }

    throw new StoreRejectedError(
      `Run '${runId}' cannot be claimed in status '${row.status}'. Activate a queued or suspended run.`,
    );
  }

  emitRun(write, runId, "claimed");

  return rowToRun(requireRun(write, runId));
}

export function wakeRun(write: SqlWrite, runId: string, at: string): WakeError | undefined {
  const row = readRun(write, runId);

  if (!row) {
    return "not_found";
  }

  if (row.owner_token !== null) {
    if (!isStale(write, row, write.now)) {
      return "owned_elsewhere";
    }

    releaseOwner(write, row);
  }

  if (isTerminalRun(row.status)) {
    return "not_claimable";
  }

  markWoken(write, runId, at);
}

// A resolved hook wakes its run whether or not an activation owns it.
export function markWoken(write: SqlWrite, runId: string, at: string): void {
  write.db.query(WAKE).run(utc(at), write.at, runId);
  emitRun(write, runId, "woken");
}

export function heartbeatRun(write: SqlWrite, runId: string, token: string): boolean {
  requireRun(write, runId);

  const changed =
    write.db
      .query("UPDATE runs SET heartbeat_at=?,updated_at=? WHERE id=? AND owner_token=?")
      .run(write.at, write.at, runId, token).changes === 1;

  if (changed) {
    emitRun(write, runId, "heartbeat");
  }

  return changed;
}

export function releaseRun(write: SqlWrite, runId: string, token: string): void {
  const previous = requireRun(write, runId);

  if (previous.owner_token !== token) {
    throw new OwnershipError(runId);
  }

  releaseOwner(write, previous);
}

export function suspendRun(
  write: SqlWrite,
  runId: string,
  token: string,
  wakeAt: string | null,
): void {
  write.db
    .query(
      "UPDATE runs SET status='suspended',wake_at=?,updated_at=? WHERE id=? AND owner_token=? AND status='running'",
    )
    .run(wakeAt, write.at, runId, token);
  emitRun(write, runId, "suspended");
}

export function finishRun(
  write: SqlWrite,
  runId: string,
  token: string,
  outcome: RunOutcome,
): void {
  write.db
    .query(
      "UPDATE runs SET status=?,output_json=?,error=?,wake_at=NULL,next_retry_at=NULL,updated_at=? WHERE id=? AND owner_token=? AND status='running'",
    )
    .run(
      outcome.status,
      outcome.status === "succeeded" ? JSON.stringify(outcome.output) : null,
      outcome.status === "failed" ? outcome.error : null,
      write.at,
      runId,
      token,
    );
  emitRun(write, runId, "finished");
}

export function readDueRuns(ctx: SqlContext, now: string): RunRecord[] {
  return ctx.db
    .query<RunRow, [string]>(
      `SELECT * FROM runs WHERE (owner_token IS NULL AND
    (status IN ('queued','running') OR (status='suspended' AND wake_at<=?))) OR
    (owner_token IS NOT NULL AND status IN ('running','suspended')) ORDER BY created_at,rowid`,
    )
    .all(utc(now))
    .filter((row) => row.owner_token === null || isStale(ctx, row, Date.parse(now)))
    .map(rowToRun);
}

export function readNextWakeAt(ctx: SqlContext): string | undefined {
  return (
    ctx.db
      .query<{ wake_at: string | null }, []>(
        "SELECT MIN(wake_at) AS wake_at FROM runs WHERE status='suspended' AND owner_token IS NULL",
      )
      .get()?.wake_at ?? undefined
  );
}

export function acquireRateLimit(
  ctx: SqlContext,
  limit: { key: string; count: number; windowMs: number; now: string },
) {
  const window =
    ctx.db
      .query<RateLimitWindow, [string]>(
        "SELECT window_start AS windowStart,count FROM rate_limits WHERE key=?",
      )
      .get(limit.key) ?? undefined;

  const acquired = acquireWindow(window, limit.count, limit.windowMs, limit.now);
  ctx.db
    .query(
      "INSERT INTO rate_limits VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET window_start=excluded.window_start,count=excluded.count",
    )
    .run(limit.key, acquired.window.windowStart, acquired.window.count);

  return acquired.result;
}
