import type { Json, LogRecord, RunRecord, Schedule, StepRecord } from "../core/index.js";
import type { LogRow, RunRow, ScheduleRow, StepColumns, StepRow } from "./store-schema.js";

export const SQL = {
  schedules: "SELECT * FROM schedules ORDER BY rowid",
  schedule: "SELECT * FROM schedules WHERE workspace=? AND slug=?",
  putSchedule: `INSERT INTO schedules VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(workspace,slug) DO UPDATE SET
    cron=excluded.cron,tz=excluded.tz,input_json=excluded.input_json,enabled=excluded.enabled,
    last_fire_key=excluded.last_fire_key,next_fire_at=excluded.next_fire_at`,
  deleteSchedule: "DELETE FROM schedules WHERE workspace=? AND slug=?",
  fireSchedule: "UPDATE schedules SET last_fire_key=?,next_fire_at=? WHERE workspace=? AND slug=?",
  nextWakeAt:
    "SELECT MIN(wake_at) AS wake_at FROM runs WHERE status='suspended' AND owner_token IS NULL",
  run: "SELECT * FROM runs WHERE id=?",
  createRun: `INSERT INTO runs VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  listRuns: "SELECT * FROM runs ORDER BY rowid",
  listRunsBySlug: "SELECT * FROM runs WHERE slug=? ORDER BY rowid",
  listRunsByStatus: "SELECT * FROM runs WHERE status=? ORDER BY rowid",
  listRunsBySlugAndStatus: "SELECT * FROM runs WHERE slug=? AND status=? ORDER BY rowid",
  claim: `UPDATE runs SET owner_token=?,owner_pid=?,owner_host=?,heartbeat_at=?,updated_at=?,status='running',wake_at=NULL WHERE id=? AND owner_token IS NULL AND status IN ('queued','suspended')`,
  heartbeat: "UPDATE runs SET heartbeat_at=?,updated_at=? WHERE id=? AND owner_token=?",
  suspend:
    "UPDATE runs SET status='suspended',wake_at=?,updated_at=? WHERE id=? AND owner_token=? AND status='running'",
  finish:
    "UPDATE runs SET status=?,output_json=?,error=?,wake_at=NULL,updated_at=? WHERE id=? AND owner_token=? AND status='running'",
  release:
    "UPDATE runs SET wake_at=CASE WHEN status='running' THEN ? ELSE wake_at END,status=CASE WHEN status='running' THEN 'suspended' ELSE status END,owner_token=NULL,owner_pid=NULL,owner_host=NULL,heartbeat_at=NULL,updated_at=? WHERE id=? AND owner_token=?",
  steps: "SELECT * FROM steps WHERE run_id=? ORDER BY seq",
  putStep: `INSERT INTO steps VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(run_id,seq) DO UPDATE SET key=excluded.key,kind=excluded.kind,
    input_json=excluded.input_json,attempt=excluded.attempt,max_attempts=excluded.max_attempts,
    started_at=excluded.started_at,status=excluded.status,output_json=excluded.output_json,
    error=excluded.error,next_retry_at=excluded.next_retry_at,wake_at=excluded.wake_at,
    finish_order=excluded.finish_order,ended_at=excluded.ended_at`,
  appendLog: "INSERT INTO logs VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
  logExists: "SELECT seq FROM logs WHERE run_id=? AND seq=?",
  logs: "SELECT * FROM logs WHERE run_id=? AND seq>? ORDER BY seq",
  dueRuns: `SELECT * FROM runs WHERE (owner_token IS NULL AND
    (status='queued' OR (status='suspended' AND wake_at<=?))) OR
    (owner_token IS NOT NULL AND status='running') ORDER BY created_at,rowid`,
  recoverSteps: `UPDATE steps SET status='retrying',error='Runner lost ownership. Retrying unfinished step.',
    next_retry_at=?,ended_at=? WHERE run_id=? AND status='running'`,
};

function decode(value: string): Json {
  return JSON.parse(value);
}

export function rowToRun(row: RunRow): RunRecord {
  const run: RunRecord = {
    id: row.id,
    slug: row.slug,
    bundleHash: row.bundle_hash,
    workspace: row.workspace,
    input: decode(row.input_json),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };

  if (row.output_json !== null) {
    run.output = decode(row.output_json);
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

export function rowToStep(row: StepRow): StepRecord {
  const base = {
    runId: row.run_id,
    seq: row.seq,
    key: row.key,
    kind: row.kind,
    input: decode(row.input_json),
    attempt: row.attempt,
    maxAttempts: row.max_attempts,
    startedAt: row.started_at,
  };

  switch (row.status) {
    case "running":
      return { ...base, status: row.status };
    case "succeeded":
      return {
        ...base,
        status: row.status,
        output: decode(row.output_json),
        endedAt: row.ended_at,
        finishOrder: row.finish_order,
      };
    case "failed":
      return {
        ...base,
        status: row.status,
        error: row.error,
        endedAt: row.ended_at,
        finishOrder: row.finish_order,
      };
    case "retrying":
      return {
        ...base,
        status: row.status,
        error: row.error,
        nextRetryAt: row.next_retry_at,
        endedAt: row.ended_at,
      };
    case "sleeping":
      return { ...base, status: row.status, wakeAt: row.wake_at };
  }
}

export function stepToRow(step: StepRecord): StepRow {
  const base: StepColumns = {
    run_id: step.runId,
    seq: step.seq,
    key: step.key,
    kind: step.kind,
    input_json: JSON.stringify(step.input),
    attempt: step.attempt,
    max_attempts: step.maxAttempts,
    started_at: new Date(step.startedAt).toISOString(),
    output_json: null,
    error: null,
    next_retry_at: null,
    wake_at: null,
    finish_order: null,
    ended_at: null,
  };

  switch (step.status) {
    case "running":
      return { ...base, status: step.status };
    case "succeeded":
      return {
        ...base,
        status: step.status,
        output_json: JSON.stringify(step.output),
        ended_at: new Date(step.endedAt).toISOString(),
        finish_order: step.finishOrder,
      };
    case "failed":
      return {
        ...base,
        status: step.status,
        error: step.error,
        ended_at: new Date(step.endedAt).toISOString(),
        finish_order: step.finishOrder,
      };
    case "retrying":
      return {
        ...base,
        status: step.status,
        error: step.error,
        next_retry_at: new Date(step.nextRetryAt).toISOString(),
        ended_at: new Date(step.endedAt).toISOString(),
      };
    case "sleeping":
      return { ...base, status: step.status, wake_at: new Date(step.wakeAt).toISOString() };
  }
}

export function rowToLog(row: LogRow): LogRecord {
  const log: LogRecord = {
    runId: row.run_id,
    seq: row.seq,
    position: rowToPosition(row),
    level: row.level,
    message: row.message,
    at: row.at,
  };

  if (row.data_json !== null) {
    log.data = decode(row.data_json);
  }

  return log;
}

function rowToPosition(row: LogRow): LogRecord["position"] {
  switch (row.position_kind) {
    case "workflow":
      return {
        kind: row.position_kind,
        afterStep: row.after_step,
        afterFinish: row.after_finish,
        index: row.log_index,
      };
    case "step":
      return {
        kind: row.position_kind,
        seq: row.step_seq,
        attempt: row.attempt,
        index: row.log_index,
      };
  }
}

export function rowToSchedule(row: ScheduleRow): Schedule {
  const schedule: Schedule = {
    workspace: row.workspace,
    slug: row.slug,
    cron: row.cron,
    tz: row.tz,
    input: decode(row.input_json),
    enabled: row.enabled === 1,
    nextFireAt: row.next_fire_at,
  };

  if (row.last_fire_key !== null) {
    schedule.lastFireKey = row.last_fire_key;
  }

  return schedule;
}
