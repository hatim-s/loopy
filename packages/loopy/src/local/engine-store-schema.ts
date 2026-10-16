import type { EngineLog, EngineRun, EngineStep, Json, StepKind } from "../core/index.js";

export const SCHEMA_VERSION = 3;

export const SCHEMA = `
  CREATE TABLE runs (
    id TEXT PRIMARY KEY, slug TEXT NOT NULL, bundle_hash TEXT NOT NULL,
    input_json TEXT NOT NULL, status TEXT NOT NULL, output_json TEXT, error TEXT,
    wake_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    owner_token TEXT, owner_pid INTEGER, owner_host TEXT, heartbeat_at TEXT
  );
  CREATE INDEX runs_due ON runs(status, wake_at, created_at);
  CREATE TABLE steps (
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL, key TEXT NOT NULL, kind TEXT NOT NULL,
    input_json TEXT NOT NULL, attempt INTEGER NOT NULL, max_attempts INTEGER NOT NULL,
    started_at TEXT NOT NULL, status TEXT NOT NULL, output_json TEXT, error TEXT,
    next_retry_at TEXT, wake_at TEXT, finish_order INTEGER, ended_at TEXT,
    PRIMARY KEY (run_id, seq)
  );
  CREATE TABLE logs (
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL, after_step INTEGER NOT NULL, after_finish INTEGER NOT NULL,
    log_index INTEGER NOT NULL, level TEXT NOT NULL, message TEXT NOT NULL,
    data_json TEXT, at TEXT NOT NULL, PRIMARY KEY (run_id, seq)
  );
  CREATE TABLE schedules (
    slug TEXT PRIMARY KEY, cron TEXT NOT NULL, tz TEXT NOT NULL,
    input_json TEXT NOT NULL, enabled INTEGER NOT NULL,
    last_fire_key TEXT, next_fire_at TEXT
  );
  CREATE TABLE rate_limits (
    key TEXT PRIMARY KEY, window_start TEXT NOT NULL, count INTEGER NOT NULL
  );
  CREATE TABLE hooks (
    token TEXT PRIMARY KEY, run_id TEXT NOT NULL, seq INTEGER NOT NULL,
    name TEXT NOT NULL, payload_json TEXT, wake_at TEXT,
    FOREIGN KEY (run_id, seq) REFERENCES steps(run_id, seq) ON DELETE CASCADE
  );
`;

export const SQL = {
  run: "SELECT * FROM runs WHERE id=?",
  createRun: `INSERT INTO runs VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  listRuns: `SELECT * FROM runs WHERE (? IS NULL OR slug=?) AND (? IS NULL OR status=?) ORDER BY rowid`,
  claim: `UPDATE runs SET owner_token=?,owner_pid=?,owner_host=?,heartbeat_at=?,updated_at=?,status='running',wake_at=NULL WHERE id=? AND owner_token IS NULL AND status IN ('queued','suspended')`,
  heartbeat: "UPDATE runs SET heartbeat_at=?,updated_at=? WHERE id=? AND owner_token=?",
  suspend:
    "UPDATE runs SET status='suspended',wake_at=?,updated_at=? WHERE id=? AND owner_token=? AND status='running'",
  finish:
    "UPDATE runs SET status=?,output_json=?,error=?,wake_at=NULL,updated_at=? WHERE id=? AND owner_token=? AND status='running'",
  release:
    "UPDATE runs SET owner_token=NULL,owner_pid=NULL,owner_host=NULL,heartbeat_at=NULL,updated_at=? WHERE id=? AND owner_token=?",
  steps: "SELECT * FROM steps WHERE run_id=? ORDER BY seq",
  putStep: `INSERT INTO steps VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(run_id,seq) DO UPDATE SET key=excluded.key,kind=excluded.kind,
    input_json=excluded.input_json,attempt=excluded.attempt,max_attempts=excluded.max_attempts,
    started_at=excluded.started_at,status=excluded.status,output_json=excluded.output_json,
    error=excluded.error,next_retry_at=excluded.next_retry_at,wake_at=excluded.wake_at,
    finish_order=excluded.finish_order,ended_at=excluded.ended_at`,
  appendLog: "INSERT INTO logs VALUES (?,?,?,?,?,?,?,?,?)",
  logExists: "SELECT seq FROM logs WHERE run_id=? AND seq=?",
  logs: "SELECT * FROM logs WHERE run_id=? AND seq>? ORDER BY seq",
  dueRuns: `SELECT * FROM runs WHERE owner_token IS NULL AND
    (status='queued' OR (status='suspended' AND julianday(wake_at)<=julianday(?))) ORDER BY created_at,rowid`,
};

export type RunRow = {
  id: string;
  slug: string;
  bundle_hash: string;
  input_json: string;
  status: EngineRun["status"];
  output_json: string | null;
  error: string | null;
  wake_at: string | null;
  created_at: string;
  updated_at: string;
  owner_token: string | null;
  owner_pid: number | null;
  owner_host: string | null;
  heartbeat_at: string | null;
};

type StepColumns = {
  run_id: string;
  seq: number;
  key: string;
  kind: StepKind;
  input_json: string;
  attempt: number;
  max_attempts: number;
  started_at: string;
  output_json: string | null;
  error: string | null;
  next_retry_at: string | null;
  wake_at: string | null;
  finish_order: number | null;
  ended_at: string | null;
};

export type StepRow = StepColumns &
  (
    | { status: "running" }
    | { status: "succeeded"; output_json: string; ended_at: string; finish_order: number }
    | { status: "failed"; error: string; ended_at: string; finish_order: number }
    | { status: "retrying"; error: string; next_retry_at: string; ended_at: string }
    | { status: "sleeping"; wake_at: string }
  );

export type LogRow = {
  run_id: string;
  seq: number;
  after_step: number;
  after_finish: number;
  log_index: number;
  level: EngineLog["level"];
  message: string;
  data_json: string | null;
  at: string;
};

function decode(value: string): Json {
  return JSON.parse(value);
}

export function rowToRun(row: RunRow): EngineRun {
  const run: EngineRun = {
    id: row.id,
    slug: row.slug,
    bundleHash: row.bundle_hash,
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

export function rowToStep(row: StepRow): EngineStep {
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

export function stepToRow(step: EngineStep): StepRow {
  const base: StepColumns = {
    run_id: step.runId,
    seq: step.seq,
    key: step.key,
    kind: step.kind,
    input_json: JSON.stringify(step.input),
    attempt: step.attempt,
    max_attempts: step.maxAttempts,
    started_at: step.startedAt,
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
        ended_at: step.endedAt,
        finish_order: step.finishOrder,
      };
    case "failed":
      return {
        ...base,
        status: step.status,
        error: step.error,
        ended_at: step.endedAt,
        finish_order: step.finishOrder,
      };
    case "retrying":
      return {
        ...base,
        status: step.status,
        error: step.error,
        next_retry_at: step.nextRetryAt,
        ended_at: step.endedAt,
      };
    case "sleeping":
      return { ...base, status: step.status, wake_at: step.wakeAt };
  }
}

export function rowToLog(row: LogRow): EngineLog {
  const log: EngineLog = {
    runId: row.run_id,
    seq: row.seq,
    position: { afterStep: row.after_step, afterFinish: row.after_finish, index: row.log_index },
    level: row.level,
    message: row.message,
    at: row.at,
  };

  if (row.data_json !== null) {
    log.data = decode(row.data_json);
  }

  return log;
}
