import type { RunRecord, RuntimeEvent } from "../../core/index.js";

export const SCHEMA_VERSION = 14;

export const SCHEMA = `
  CREATE TABLE events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, txn TEXT NOT NULL,
    entity TEXT NOT NULL, kind TEXT NOT NULL, run_id TEXT, record TEXT NOT NULL
  );
  CREATE INDEX events_run_sequence ON events(run_id, sequence);
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE runs (
    id TEXT PRIMARY KEY, slug TEXT NOT NULL, revision TEXT NOT NULL, workspace TEXT NOT NULL,
    input_json TEXT NOT NULL, status TEXT NOT NULL, output_json TEXT, error TEXT,
    wake_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    owner_token TEXT, owner_pid INTEGER, owner_host TEXT, heartbeat_at TEXT
  );
  CREATE INDEX runs_slug_created ON runs(slug, created_at);
  CREATE INDEX runs_due ON runs(status, wake_at, created_at);
  CREATE TABLE node_runs (
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    execution_key TEXT NOT NULL, attempt INTEGER NOT NULL, status TEXT NOT NULL,
    started_at TEXT NOT NULL, finished_at TEXT, output TEXT, error TEXT, receipt TEXT NOT NULL,
    record TEXT NOT NULL, PRIMARY KEY(run_id,execution_key)
  );
  CREATE TABLE logs (
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    execution_key TEXT NOT NULL, attempt INTEGER NOT NULL, log_index INTEGER NOT NULL,
    seq INTEGER NOT NULL, record TEXT NOT NULL,
    PRIMARY KEY(execution_key,attempt,log_index), UNIQUE(run_id,seq)
  );
  CREATE TABLE rate_limits (key TEXT PRIMARY KEY, window_start TEXT NOT NULL, count INTEGER NOT NULL);
  CREATE TABLE schedules (
    workspace TEXT NOT NULL, slug TEXT NOT NULL, cron TEXT NOT NULL, tz TEXT NOT NULL,
    input_json TEXT NOT NULL, enabled INTEGER NOT NULL,
    last_fire_key TEXT, next_fire_at TEXT NOT NULL, version INTEGER NOT NULL, PRIMARY KEY (workspace, slug)
  );
`;

export type RunRow = {
  id: string;
  slug: string;
  revision: string;
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

export type ScheduleRow = {
  version: number;
  workspace: string;
  slug: string;
  cron: string;
  tz: string;
  input_json: string;
  enabled: number;
  last_fire_key: string | null;
  next_fire_at: string;
};

export type EventRow = {
  sequence: number;
  at: string;
  txn: string;
  run_id: string | null;
  record: string;
} & {
  [E in RuntimeEvent["entity"]]: Pick<Extract<RuntimeEvent, { entity: E }>, "entity" | "kind">;
}[RuntimeEvent["entity"]];

export type LogRow = { record: string };
