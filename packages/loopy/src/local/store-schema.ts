import type {
  AttemptRecord,
  AttemptStatus,
  Json,
  RunEvent,
  RunEventType,
  RunRecord,
  RunStatus,
} from "../core/index.js";

export const SCHEMA_VERSION = 2;
export const SCHEMA = `
  CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL,
    workflow_json TEXT NOT NULL,
    workflow_hash TEXT NOT NULL,
    input_json TEXT NOT NULL,
    options_json TEXT NOT NULL,
    status TEXT NOT NULL,
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    owner_token TEXT,
    owner_pid INTEGER,
    owner_host TEXT,
    heartbeat_at TEXT
  );
  CREATE INDEX IF NOT EXISTS runs_slug_created ON runs(slug, created_at DESC);
  CREATE TABLE IF NOT EXISTS attempts (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    node_id TEXT NOT NULL,
    number INTEGER NOT NULL CHECK(number > 0),
    status TEXT NOT NULL,
    input_json TEXT NOT NULL,
    output_json TEXT,
    error TEXT,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    UNIQUE(run_id, node_id, number)
  );
  CREATE INDEX IF NOT EXISTS attempts_run ON attempts(run_id, node_id, number);
  CREATE TABLE IF NOT EXISTS events (
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    sequence INTEGER NOT NULL,
    node_id TEXT,
    type TEXT NOT NULL,
    data_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY(run_id, sequence)
  );
`;

export type RunRow = {
  id: string;
  slug: string;
  workflow_json: string;
  workflow_hash: string;
  input_json: string;
  options_json: string;
  status: RunStatus;
  error: string | null;
  created_at: string;
  updated_at: string;
  owner_token: string | null;
  owner_pid: number | null;
  owner_host: string | null;
  heartbeat_at: string | null;
};

export type AttemptRow = {
  id: string;
  run_id: string;
  node_id: string;
  number: number;
  status: AttemptStatus;
  input_json: string;
  output_json: string | null;
  error: string | null;
  started_at: string;
  ended_at: string | null;
};

export type EventRow = {
  sequence: number;
  run_id: string;
  node_id: string | null;
  type: RunEventType;
  data_json: string;
  created_at: string;
};

export function now(): string {
  return new Date().toISOString();
}

export function encode(value: Json): string {
  return JSON.stringify(value);
}

export function decode<T>(value: string): T {
  return JSON.parse(value) as T;
}

export function runFromRow(row: RunRow): RunRecord {
  return {
    id: row.id,
    slug: row.slug,
    workflow: decode(row.workflow_json),
    workflowHash: row.workflow_hash,
    input: decode(row.input_json),
    options: decode(row.options_json),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    error: row.error ?? undefined,
  };
}

export function attemptFromRow(row: AttemptRow): AttemptRecord {
  return {
    id: row.id,
    runId: row.run_id,
    nodeId: row.node_id,
    number: row.number,
    status: row.status,
    input: decode(row.input_json),
    output: row.output_json === null ? undefined : decode(row.output_json),
    error: row.error ?? undefined,
    startedAt: row.started_at,
    endedAt: row.ended_at ?? undefined,
  };
}

export function eventFromRow(row: EventRow): RunEvent {
  return {
    sequence: row.sequence,
    runId: row.run_id,
    nodeId: row.node_id ?? undefined,
    type: row.type,
    data: decode(row.data_json),
    createdAt: row.created_at,
  };
}
