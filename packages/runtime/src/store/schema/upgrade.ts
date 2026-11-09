// Frozen step for schema 15 stores. It never follows the fresh schema; the runtime README says when it can go.
// Event reads decode every record strictly, so retained payloads are rewritten in place to the
// schema 16 event union, keeping sequences, txns and epoch. Schema 15 run events carried
// nextRetryAt and wrote wakeAt only when set. Schema 15 schedules had no failure record, so
// every retained saved or fired event states none. Node, log, hook and schedule deletion
// payloads already match.
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
  ALTER TABLE runs DROP COLUMN next_retry_at;
  UPDATE events SET record=json_remove(record,'$.nextRetryAt') WHERE entity='run';
  UPDATE events SET record=json_remove(record,'$.wakeAt')
    WHERE entity='run' AND json_extract(record,'$.status')<>'suspended';
  UPDATE events SET record=json_set(record,'$.wakeAt',json('null'))
    WHERE entity='run' AND json_extract(record,'$.status')='suspended'
      AND json_type(record,'$.wakeAt') IS NULL;
  UPDATE events SET record=json_insert(record,'$.failure',json('null'))
    WHERE entity='schedule' AND kind<>'deleted';
`;
