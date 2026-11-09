import type { SqlDriver } from "../driver";
import { StoreRejectedError } from "../operation";
import { SCHEMA_15_TO_16 } from "./upgrade";

export const SCHEMA_VERSION = 16;

const FRESH_SCHEMA = `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE runs (
    id TEXT PRIMARY KEY, slug TEXT NOT NULL, revision TEXT NOT NULL, workspace TEXT NOT NULL,
    input_json TEXT NOT NULL, status TEXT NOT NULL, output_json TEXT, error TEXT,
    wake_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    owner_token TEXT, owner_pid INTEGER, owner_host TEXT, heartbeat_at TEXT
  );
  CREATE INDEX runs_workspace_created_id ON runs(workspace,created_at DESC,id DESC);
  CREATE INDEX runs_created_id ON runs(created_at DESC,id DESC);
  CREATE INDEX runs_slug_created_id ON runs(slug,created_at DESC,id DESC);
  CREATE INDEX runs_status_created_id ON runs(status,created_at DESC,id DESC);
  CREATE INDEX runs_due ON runs(status,wake_at,created_at);
  CREATE TABLE waits (
    token TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    execution_key TEXT NOT NULL, record TEXT NOT NULL,
    UNIQUE(run_id, execution_key)
  );
  CREATE INDEX waits_run ON waits(run_id);
  CREATE TABLE events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, txn TEXT NOT NULL,
    entity TEXT NOT NULL, kind TEXT NOT NULL, run_id TEXT, record TEXT NOT NULL,
    node_id TEXT, slug TEXT, workspace TEXT
  );
  CREATE INDEX events_run_sequence ON events(run_id,sequence);
  CREATE INDEX events_at ON events(at);
  CREATE INDEX events_txn_sequence ON events(txn,sequence);
  CREATE TABLE node_runs (
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    execution_key TEXT NOT NULL, attempt INTEGER NOT NULL, status TEXT NOT NULL,
    started_at TEXT NOT NULL, finished_at TEXT, output TEXT, error TEXT, receipt TEXT NOT NULL,
    record TEXT NOT NULL, node_id TEXT NOT NULL DEFAULT '', scope TEXT NOT NULL DEFAULT '[]',
    PRIMARY KEY(run_id,execution_key)
  );
  CREATE INDEX node_runs_scope ON node_runs(run_id,scope,execution_key);
  CREATE TABLE node_attempts (
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    execution_key TEXT NOT NULL, attempt INTEGER NOT NULL, record TEXT NOT NULL,
    PRIMARY KEY(run_id,execution_key,attempt)
  );
  CREATE TABLE node_scopes (
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    execution_key TEXT NOT NULL, map_node TEXT NOT NULL, parent_scope TEXT NOT NULL,
    item_index INTEGER NOT NULL, status TEXT NOT NULL,
    PRIMARY KEY(run_id,execution_key,map_node,parent_scope)
  );
  CREATE INDEX node_scopes_items ON node_scopes(run_id,map_node,parent_scope,item_index,status);
  CREATE INDEX node_scopes_parent ON node_scopes(run_id,parent_scope,map_node,status,item_index);
  CREATE TABLE logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    execution_key TEXT NOT NULL, attempt INTEGER NOT NULL, log_index INTEGER NOT NULL,
    seq INTEGER NOT NULL, record TEXT NOT NULL, node_id TEXT NOT NULL,
    at TEXT NOT NULL, level TEXT NOT NULL, message TEXT NOT NULL, data_bytes INTEGER NOT NULL,
    UNIQUE(execution_key,attempt,log_index), UNIQUE(run_id,seq)
  );
  CREATE INDEX logs_run_id ON logs(run_id,id);
  CREATE TABLE log_attempt_usage (
    execution_key TEXT NOT NULL, attempt INTEGER NOT NULL, bytes INTEGER NOT NULL,
    PRIMARY KEY(execution_key,attempt)
  );
  CREATE TABLE rate_limits (key TEXT PRIMARY KEY, window_start TEXT NOT NULL, count INTEGER NOT NULL);
  CREATE TABLE schedules (
    workspace TEXT NOT NULL, slug TEXT NOT NULL, cron TEXT NOT NULL, tz TEXT NOT NULL,
    input_json TEXT NOT NULL, enabled INTEGER NOT NULL,
    last_fire_key TEXT, next_fire_at TEXT NOT NULL, version INTEGER NOT NULL,
    PRIMARY KEY(workspace,slug)
  );
  CREATE INDEX schedules_enabled_next ON schedules(enabled,next_fire_at,workspace,slug);
  CREATE TABLE schedule_failures (
    workspace TEXT NOT NULL, slug TEXT NOT NULL, version INTEGER NOT NULL,
    retry_at TEXT, error TEXT NOT NULL,
    PRIMARY KEY(workspace,slug),
    FOREIGN KEY(workspace,slug) REFERENCES schedules(workspace,slug) ON DELETE CASCADE
  );
  CREATE TABLE run_turns (
    run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
    next_at TEXT NOT NULL, cursor TEXT, error TEXT
  );
`;

function markSchemaVersion(db: SqlDriver): void {
  db.query("INSERT OR REPLACE INTO meta VALUES ('schema_version',?)").run(String(SCHEMA_VERSION));
}

export function runScript(db: SqlDriver, script: string): void {
  for (const statement of script.split(";")) {
    if (statement.trim().length > 0) {
      db.exec(statement);
    }
  }
}

function createSchema(db: SqlDriver): void {
  runScript(db, FRESH_SCHEMA);

  db.query("INSERT INTO meta VALUES ('epoch',?)").run(crypto.randomUUID());
  markSchemaVersion(db);
}

export function initializeSchema(db: SqlDriver): void {
  db.transaction(() => {
    const tables = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'",
      )
      .all()
      // Durable Objects keep their own _cf and __cf tables in the same database.
      .filter((table) => !table.name.startsWith("_cf") && !table.name.startsWith("__cf"));

    if (tables.length === 0) {
      createSchema(db);

      return;
    }

    const version = tables.some((table) => table.name === "meta")
      ? db.query<{ value: string }, []>("SELECT value FROM meta WHERE key='schema_version'").get()
          ?.value
      : undefined;

    if (version === "15") {
      runScript(db, SCHEMA_15_TO_16);
      markSchemaVersion(db);

      return;
    }

    if (version !== String(SCHEMA_VERSION)) {
      throw new StoreRejectedError(
        `SQL store schema ${version ?? "unknown"} cannot be opened. Preserve the database and migrate it before opening this store.`,
      );
    }
  }, "immediate");
}
