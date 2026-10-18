import { hostname } from "node:os";
import {
  isTerminalRun,
  type RunOutcome,
  type RunRecord,
  type RunStatus,
  type RuntimeEvent,
  StoreError,
  type WakeError,
} from "../../core/index.js";
import { processAlive } from "../../executor/index.js";
import type { EventTransaction } from "../event-outbox.js";
import type { StoreContext } from "./context.js";
import { commit, emit, nowIso } from "./events.js";
import type { RunRow } from "./store-schema.js";

const SQL = {
  wakeRun: "UPDATE runs SET wake_at=?,updated_at=? WHERE id=?",
  nextWakeAt:
    "SELECT MIN(wake_at) AS wake_at FROM runs WHERE status='suspended' AND owner_token IS NULL",
  run: "SELECT * FROM runs WHERE id=?",
  createRun: `INSERT INTO runs VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  listRuns:
    "SELECT * FROM runs WHERE (?1 IS NULL OR slug=?1) AND (?2 IS NULL OR status=?2) ORDER BY rowid",
  claim: `UPDATE runs SET owner_token=?,owner_pid=?,owner_host=?,heartbeat_at=?,updated_at=?,status='running',wake_at=NULL WHERE id=? AND owner_token IS NULL AND status IN ('queued','suspended','running')`,
  heartbeat: "UPDATE runs SET heartbeat_at=?,updated_at=? WHERE id=? AND owner_token=?",
  finish:
    "UPDATE runs SET status=?,output_json=?,error=?,wake_at=NULL,updated_at=? WHERE id=? AND owner_token=? AND status='running'",
  release:
    "UPDATE runs SET wake_at=CASE WHEN status='running' THEN ? ELSE wake_at END,status=CASE WHEN status='running' THEN 'suspended' ELSE status END,owner_token=NULL,owner_pid=NULL,owner_host=NULL,heartbeat_at=NULL,updated_at=? WHERE id=? AND owner_token=?",
  dueRuns: `SELECT * FROM runs WHERE (owner_token IS NULL AND
    (status IN ('queued','running') OR (status='suspended' AND wake_at<=?))) OR
    (owner_token IS NOT NULL AND status='running') ORDER BY created_at,rowid`,
};

export function rowToRun(row: RunRow): RunRecord {
  const run: RunRecord = {
    id: row.id,
    slug: row.slug,
    revision: row.revision,
    projectRoot: row.project_root,
    runDirectory: row.run_directory,
    input: JSON.parse(row.input_json),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };

  if (row.output_json !== null) {
    run.output = JSON.parse(row.output_json);
  }

  if (row.error !== null) {
    run.error = row.error;
  }

  if (row.wake_at !== null) {
    run.wakeAt = row.wake_at;
  }

  if (
    row.owner_token !== null &&
    row.owner_pid !== null &&
    row.owner_host !== null &&
    row.heartbeat_at !== null
  ) {
    run.owner = {
      token: row.owner_token,
      pid: row.owner_pid,
      host: row.owner_host,
      heartbeatAt: row.heartbeat_at,
    };
  }

  return run;
}

export function stale(context: StoreContext, row: RunRow, now: number): boolean {
  if (row.status !== "running" || row.owner_token === null || row.heartbeat_at === null) {
    return false;
  }

  if (row.owner_host === hostname() && row.owner_pid !== null) {
    if (processAlive(row.owner_pid)) {
      return false;
    }
  }

  return now - Date.parse(row.heartbeat_at) > context.leaseMs;
}

export function getRow(context: StoreContext, runId: string): RunRow | undefined {
  return context.db.query<RunRow, [string]>(SQL.run).get(runId) ?? undefined;
}

export function requireRow(context: StoreContext, runId: string): RunRow {
  const row = getRow(context, runId);

  if (!row) {
    throw new StoreError("not_found");
  }

  return row;
}

export function owned(context: StoreContext, runId: string, token: string): RunRow {
  const row = requireRow(context, runId);

  if (row.owner_token !== token) {
    throw new StoreError("owned_elsewhere");
  }

  return row;
}

export function requireRunning(row: RunRow): void {
  if (row.status !== "running") {
    throw new StoreError("not_running");
  }
}

export async function createRun(context: StoreContext, run: RunRecord): Promise<void> {
  commit(context, (txn) => {
    if (getRow(context, run.id)) {
      throw new StoreError("already_exists");
    }

    insertRun(context, run);
    emitRun(context, txn, run.id, "created");
  });
}

export async function getRun(context: StoreContext, id: string): Promise<RunRecord | undefined> {
  const row = getRow(context, id);

  return row ? rowToRun(row) : undefined;
}

export async function listRuns(
  context: StoreContext,
  filter: { slug?: string; status?: RunStatus } = {},
): Promise<RunRecord[]> {
  return context.db
    .query<RunRow, [string | null, RunStatus | null]>(SQL.listRuns)
    .all(filter.slug ?? null, filter.status ?? null)
    .map(rowToRun);
}

export async function claim(
  context: StoreContext,
  runId: string,
  token: string,
): Promise<RunRecord> {
  return commit(context, (txn) => {
    const timestamp = nowIso(context);

    const previous = requireRow(context, runId);

    if (stale(context, previous, context.now())) {
      recoverRun(context, txn, previous, timestamp);
    }

    const result = context.db
      .query(SQL.claim)
      .run(token, process.pid, hostname(), timestamp, timestamp, runId);

    if (result.changes !== 1) {
      const row = requireRow(context, runId);

      if (row.owner_token !== null) {
        throw new StoreError("owned_elsewhere");
      }

      throw new StoreError("not_claimable");
    }

    emitRun(context, txn, runId, "claimed");

    return rowToRun(requireRow(context, runId));
  });
}

export function recoverRun(
  context: StoreContext,
  txn: EventTransaction,
  previous: RunRow,
  timestamp: string,
): void {
  const runId = previous.id;
  context.db.query(SQL.release).run(timestamp, timestamp, runId, previous.owner_token);
  emitRun(context, txn, runId, "released");
}

export async function wakeRun(
  context: StoreContext,
  id: string,
  at: string,
): Promise<WakeError | undefined> {
  return commit(context, (txn) => {
    const row = getRow(context, id);

    if (!row) {
      return "not_found";
    }

    if (row.owner_token !== null) {
      if (!stale(context, row, context.now())) {
        return "owned_elsewhere";
      }

      recoverRun(context, txn, row, nowIso(context));
    }

    if (isTerminalRun(row.status)) {
      return "not_claimable";
    }

    context.db.query(SQL.wakeRun).run(at, at, id);
    emitRun(context, txn, id, "woken");

    return undefined;
  });
}

export async function heartbeat(
  context: StoreContext,
  runId: string,
  token: string,
): Promise<boolean> {
  return commit(context, (txn) => {
    requireRow(context, runId);
    const timestamp = nowIso(context);

    const changed =
      context.db.query(SQL.heartbeat).run(timestamp, timestamp, runId, token).changes === 1;

    if (changed) {
      emitRun(context, txn, runId, "heartbeat");
    }

    return changed;
  });
}

export async function release(context: StoreContext, runId: string, token: string): Promise<void> {
  commit(context, (txn) => {
    const previous = owned(context, runId, token);
    const timestamp = nowIso(context);
    context.db.query(SQL.release).run(timestamp, timestamp, runId, token);
    emitRun(context, txn, runId, "released");

    if (previous.status === "running") {
      emitRun(context, txn, runId, "suspended");
    }
  });
}

export async function dueRuns(context: StoreContext, now: string): Promise<RunRecord[]> {
  return context.db
    .query<RunRow, [string]>(SQL.dueRuns)
    .all(now)
    .filter((row) => row.owner_token === null || stale(context, row, Date.parse(now)))
    .map(rowToRun);
}

export async function nextWakeAt(context: StoreContext): Promise<string | undefined> {
  return (
    context.db.query<{ wake_at: string | null }, []>(SQL.nextWakeAt).get()?.wake_at ?? undefined
  );
}

export function emitRun(
  context: StoreContext,
  txn: EventTransaction,
  runId: string,
  kind: Extract<RuntimeEvent, { entity: "run" }>["kind"],
): void {
  emit(context, txn, { entity: "run", kind, runId, record: rowToRun(requireRow(context, runId)) });
}

export function insertRun(context: StoreContext, input: RunRecord): void {
  const run = input;

  context.db
    .query(SQL.createRun)
    .run(
      run.id,
      run.slug,
      run.revision,
      run.projectRoot,
      run.runDirectory,
      JSON.stringify(run.input),
      run.status,
      run.output === undefined ? null : JSON.stringify(run.output),
      run.error ?? null,
      run.wakeAt ?? null,
      run.createdAt,
      run.updatedAt,
      run.owner?.token ?? null,
      run.owner?.pid ?? null,
      run.owner?.host ?? null,
      run.owner?.heartbeatAt ?? null,
    );
}

export function writeOutcome(
  context: StoreContext,
  runId: string,
  outcome: RunOutcome,
  at: string,
  txn: EventTransaction,
) {
  context.db
    .query(SQL.finish)
    .run(
      outcome.status,
      outcome.status === "succeeded" ? JSON.stringify(outcome.output) : null,
      outcome.status === "failed" ? outcome.error : null,
      at,
      runId,
      requireRow(context, runId).owner_token,
    );
  emitRun(context, txn, runId, "finished");
}
