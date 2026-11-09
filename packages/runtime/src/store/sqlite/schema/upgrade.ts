// Frozen step for schema 15 stores. It never follows the fresh schema; the runtime README says when it can go.
export const SCHEMA_15_TO_16 = `
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
