import type { LogRecord, RunRecord, StepKind } from "../core/index.js";

export const SCHEMA_VERSION = 12;

export const SCHEMA = `
  CREATE TABLE events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, txn TEXT NOT NULL,
    entity TEXT NOT NULL, kind TEXT NOT NULL, run_id TEXT, record TEXT NOT NULL
  );
  CREATE INDEX events_run_sequence ON events(run_id, sequence);
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE runs (
    id TEXT PRIMARY KEY, slug TEXT NOT NULL, bundle_hash TEXT NOT NULL, workspace TEXT NOT NULL,
    input_json TEXT NOT NULL, status TEXT NOT NULL, output_json TEXT, error TEXT,
    wake_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    owner_token TEXT, owner_pid INTEGER, owner_host TEXT, heartbeat_at TEXT
  );
  CREATE INDEX runs_slug_created ON runs(slug, created_at);
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
    seq INTEGER NOT NULL, position_kind TEXT NOT NULL, after_step INTEGER, after_finish INTEGER,
    step_seq INTEGER, attempt INTEGER,
    log_index INTEGER NOT NULL, level TEXT NOT NULL, message TEXT NOT NULL,
    data_json TEXT, at TEXT NOT NULL, PRIMARY KEY (run_id, seq)
  );
  CREATE TABLE hooks (
    token TEXT PRIMARY KEY, run_id TEXT NOT NULL, seq INTEGER NOT NULL, name TEXT NOT NULL,
    payload_json TEXT, created_at TEXT NOT NULL, resolved_at TEXT, expired_at TEXT,
    UNIQUE(run_id, seq), FOREIGN KEY(run_id, seq) REFERENCES steps(run_id, seq) ON DELETE CASCADE
  );
  CREATE TABLE rate_limits (key TEXT PRIMARY KEY, window_start TEXT NOT NULL, count INTEGER NOT NULL);
  CREATE TABLE schedules (
    workspace TEXT NOT NULL, slug TEXT NOT NULL, cron TEXT NOT NULL, tz TEXT NOT NULL,
    input_json TEXT NOT NULL, enabled INTEGER NOT NULL,
    last_fire_key TEXT, next_fire_at TEXT NOT NULL, revision INTEGER NOT NULL, PRIMARY KEY (workspace, slug)
  );
`;

export type RunRow = {
  id: string;
  slug: string;
  bundle_hash: string;
  workspace: string;
  input_json: string;
  status: RunRecord["status"];
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

export type StepColumns = {
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
    | { status: "waiting" }
  );

export type LogRow = {
  run_id: string;
  seq: number;
  log_index: number;
  level: LogRecord["level"];
  message: string;
  data_json: string | null;
  at: string;
} & (
  | {
      position_kind: "workflow";
      after_step: number;
      after_finish: number;
      step_seq: null;
      attempt: null;
    }
  | {
      position_kind: "step";
      after_step: null;
      after_finish: null;
      step_seq: number;
      attempt: number;
    }
);

export type ScheduleRow = {
  revision: number;
  workspace: string;
  slug: string;
  cron: string;
  tz: string;
  input_json: string;
  enabled: number;
  last_fire_key: string | null;
  next_fire_at: string;
};

export type HookRow = {
  token: string;
  run_id: string;
  seq: number;
  name: string;
  payload_json: string | null;
  created_at: string;
  resolved_at: string | null;
  expired_at: string | null;
};

export type EventRow = {
  sequence: number;
  at: string;
  txn: string;
  entity: string;
  kind: string;
  run_id: string | null;
  record: string;
};
