import type { Database } from "bun:sqlite";

// The rebuild preserves legacy rowids as global log ids and all per-run sequences.
export const QUERY_SCHEMA = `
  DROP INDEX runs_slug_created;
  CREATE INDEX runs_workspace_created_id ON runs(workspace,created_at DESC,id DESC);
  CREATE INDEX runs_created_id ON runs(created_at DESC,id DESC);
  CREATE INDEX runs_slug_created_id ON runs(slug,created_at DESC,id DESC);
  CREATE INDEX runs_status_created_id ON runs(status,created_at DESC,id DESC);
  ALTER TABLE events ADD COLUMN node_id TEXT;
  ALTER TABLE events ADD COLUMN slug TEXT;
  ALTER TABLE events ADD COLUMN workspace TEXT;
  UPDATE events SET node_id=COALESCE(json_extract(record,'$.key.nodeId'),
    (SELECT json_extract(n.record,'$.key.nodeId') FROM node_runs n
     WHERE events.entity='log' AND n.run_id=COALESCE(events.run_id,json_extract(events.record,'$.runId'))
       AND n.execution_key=json_extract(events.record,'$.position.executionKey'))
  ),slug=COALESCE((SELECT slug FROM runs WHERE id=events.run_id),json_extract(record,'$.slug')),workspace=COALESCE((SELECT workspace FROM runs WHERE id=events.run_id),json_extract(record,'$.workspace'));
  CREATE INDEX events_at ON events(at);
  CREATE INDEX events_txn_sequence ON events(txn,sequence);
  ALTER TABLE node_runs ADD COLUMN node_id TEXT NOT NULL DEFAULT '';
  ALTER TABLE node_runs ADD COLUMN scope TEXT NOT NULL DEFAULT '[]';
  UPDATE node_runs SET node_id=json_extract(record,'$.key.nodeId'),scope=(SELECT json_group_array(json_object('nodeId',json_extract(value,'$.nodeId'),'index',json_extract(value,'$.index'))) FROM json_each(record,'$.key.scope'));
  CREATE INDEX node_runs_scope ON node_runs(run_id,scope,execution_key);
  CREATE TABLE node_attempts (
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    execution_key TEXT NOT NULL, attempt INTEGER NOT NULL, record TEXT NOT NULL,
    PRIMARY KEY(run_id,execution_key,attempt)
  );
  INSERT INTO node_attempts SELECT run_id,execution_key,attempt,record FROM node_runs;
  CREATE TABLE node_scopes (
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    execution_key TEXT NOT NULL, map_node TEXT NOT NULL, parent_scope TEXT NOT NULL,
    item_index INTEGER NOT NULL, status TEXT NOT NULL,
    PRIMARY KEY(run_id,execution_key,map_node,parent_scope)
  );
  INSERT INTO node_scopes
    SELECT n.run_id,n.execution_key,json_extract(j.value,'$.nodeId'),
      COALESCE((SELECT json_group_array(json(value)) FROM json_each(n.scope) p WHERE p.key<j.key),'[]'),
      json_extract(j.value,'$.index'),n.status
    FROM node_runs n,json_each(n.scope) j;
  CREATE INDEX node_scopes_items ON node_scopes(run_id,map_node,parent_scope,item_index,status);
  CREATE INDEX node_scopes_parent ON node_scopes(run_id,parent_scope,map_node,status,item_index);
  ALTER TABLE logs RENAME TO logs_v14;
  CREATE TABLE logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    execution_key TEXT NOT NULL, attempt INTEGER NOT NULL, log_index INTEGER NOT NULL,
    seq INTEGER NOT NULL, record TEXT NOT NULL, node_id TEXT NOT NULL,
    at TEXT NOT NULL, level TEXT NOT NULL, message TEXT NOT NULL, data_bytes INTEGER NOT NULL,
    UNIQUE(execution_key,attempt,log_index), UNIQUE(run_id,seq)
  );
  INSERT INTO logs SELECT rowid,run_id,execution_key,attempt,log_index,seq,record,
    COALESCE((SELECT node_id FROM node_runs n WHERE n.run_id=logs_v14.run_id AND n.execution_key=logs_v14.execution_key),''),
    json_extract(record,'$.at'),json_extract(record,'$.level'),json_extract(record,'$.message'),
    COALESCE(length(CAST(record->'$.data' AS BLOB)),0)
    FROM logs_v14 ORDER BY rowid;
  DROP TABLE logs_v14;
  CREATE INDEX logs_run_id ON logs(run_id,id);
  CREATE TABLE log_attempt_usage (
    execution_key TEXT NOT NULL, attempt INTEGER NOT NULL, bytes INTEGER NOT NULL,
    PRIMARY KEY(execution_key,attempt)
  );
  INSERT INTO log_attempt_usage SELECT execution_key,attempt,
    SUM(length(CAST(json_object('message',json_extract(record,'$.message'),'data',json(COALESCE(record->'$.data','null'))) AS BLOB)))
    FROM logs GROUP BY execution_key,attempt;
`;

export function applyQuerySchema(db: Database): void {
  // Each statement must report its own failure before the transaction can change the version.
  for (const statement of QUERY_SCHEMA.split(";")) {
    if (statement.trim().length > 0) {
      db.query(statement).run();
    }
  }
}
