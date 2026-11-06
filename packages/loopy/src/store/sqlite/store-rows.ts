import { Schema } from "effect";
import {
  hookRecordSchema,
  jsonSchema,
  logRecordSchema,
  nodeRunSchema,
  runStatusSchema,
  scheduleSchema,
} from "../../contract";
import {
  HOOK_EVENT_KINDS,
  NODE_RUN_STATUSES,
  RUN_EVENT_KINDS,
  type RunRecord,
  SCHEDULE_EVENT_KINDS,
  type Schedule,
} from "../../core";
import { EVENT_RETENTION } from "../event-outbox";
import { storedDecoder, storedValueDecoder } from "../row-codec";
import type { EventRow, LogRow, RunRow, ScheduleRow } from "./store-schema";

export const SQL = {
  createEpoch: "INSERT INTO meta VALUES ('epoch',?)",
  epoch: "SELECT value FROM meta WHERE key='epoch'",
  appendEvent:
    "INSERT INTO events(at,txn,entity,kind,run_id,record,node_id,slug,workspace) VALUES (?,?,?,?,?,?,?,?,?) RETURNING *",
  events: "SELECT * FROM events WHERE sequence>? ORDER BY sequence LIMIT ?",
  transactionEvents: "SELECT * FROM events WHERE txn=? AND sequence>? ORDER BY sequence",
  cursor: "SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name='events'),0) AS cursor",
  // Advancing through the last affected transaction prevents replaying a retained tail.
  pruneEvents: `WITH boundary AS (
    SELECT MAX(sequence) AS sequence FROM events WHERE at<? OR sequence<=COALESCE(
      (SELECT sequence FROM events ORDER BY sequence DESC LIMIT 1 OFFSET ${EVENT_RETENTION.maxRows}),0
    )
  ), transaction_end AS (
    SELECT MAX(sequence) AS sequence FROM events WHERE txn IN (
      SELECT txn FROM events WHERE sequence<=(SELECT sequence FROM boundary)
    )
  ) DELETE FROM events WHERE sequence<=(SELECT sequence FROM transaction_end)`,
  wakeRun: "UPDATE runs SET wake_at=?,updated_at=? WHERE id=?",
  rateLimit: "SELECT window_start AS windowStart,count FROM rate_limits WHERE key=?",
  putRateLimit:
    "INSERT INTO rate_limits VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET window_start=excluded.window_start,count=excluded.count",
  putNode: `INSERT INTO node_runs(run_id,execution_key,attempt,status,started_at,finished_at,output,error,receipt,record,node_id,scope) VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(run_id,execution_key) DO UPDATE SET attempt=excluded.attempt,status=excluded.status,started_at=excluded.started_at,finished_at=excluded.finished_at,output=excluded.output,error=excluded.error,receipt=excluded.receipt,record=excluded.record,node_id=excluded.node_id,scope=excluded.scope`,
  appendLog:
    "INSERT INTO logs(run_id,execution_key,attempt,log_index,seq,record,node_id,at,level,message,data_bytes) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
  schedules: "SELECT * FROM schedules ORDER BY rowid",
  schedule: "SELECT * FROM schedules WHERE workspace=? AND slug=?",
  putSchedule: `INSERT INTO schedules VALUES (?,?,?,?,?,?,?,?,1) ON CONFLICT(workspace,slug) DO UPDATE SET
    cron=excluded.cron,tz=excluded.tz,input_json=excluded.input_json,enabled=excluded.enabled,
    last_fire_key=excluded.last_fire_key,next_fire_at=excluded.next_fire_at,version=schedules.version+1 RETURNING *`,
  deleteSchedule: "DELETE FROM schedules WHERE workspace=? AND slug=?",
  setScheduleEnabled: `UPDATE schedules SET enabled=?,version=version+1,
    next_fire_at=COALESCE(?,next_fire_at) WHERE workspace=? AND slug=? RETURNING *`,
  advanceSchedule: `UPDATE schedules SET next_fire_at=? WHERE workspace=? AND slug=?
    AND version=? AND enabled=1`,
  fireSchedule: `UPDATE schedules SET last_fire_key=?,next_fire_at=? WHERE workspace=? AND slug=?
    AND version=? AND enabled=1 AND (last_fire_key IS NULL OR last_fire_key<>?)`,
  nextWakeAt:
    "SELECT MIN(wake_at) AS wake_at FROM runs WHERE status='suspended' AND owner_token IS NULL",
  run: "SELECT * FROM runs WHERE id=?",
  createRun: `INSERT INTO runs(id,slug,revision,workspace,input_json,status,output_json,error,wake_at,next_retry_at,created_at,updated_at,owner_token,owner_pid,owner_host,heartbeat_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  listRuns:
    "SELECT * FROM runs WHERE (?1 IS NULL OR slug=?1) AND (?2 IS NULL OR status=?2) ORDER BY rowid",
  claim: `UPDATE runs SET owner_token=?,owner_pid=?,owner_host=?,heartbeat_at=?,updated_at=?,status='running',wake_at=NULL,next_retry_at=NULL WHERE id=? AND owner_token IS NULL AND status IN ('queued','suspended','running')`,
  heartbeat: "UPDATE runs SET heartbeat_at=?,updated_at=? WHERE id=? AND owner_token=?",
  suspend:
    "UPDATE runs SET status='suspended',wake_at=?,updated_at=? WHERE id=? AND owner_token=? AND status='running'",
  finish:
    "UPDATE runs SET status=?,output_json=?,error=?,wake_at=NULL,next_retry_at=NULL,updated_at=? WHERE id=? AND owner_token=? AND status='running'",
  release:
    "UPDATE runs SET wake_at=CASE WHEN status='running' THEN ? ELSE wake_at END,status=CASE WHEN status='running' THEN 'suspended' ELSE status END,owner_token=NULL,owner_pid=NULL,owner_host=NULL,heartbeat_at=NULL,updated_at=? WHERE id=? AND owner_token=?",
  logs: "SELECT * FROM logs WHERE run_id=? AND seq>? ORDER BY seq",
  dueRuns: `SELECT * FROM runs WHERE (owner_token IS NULL AND
    (status IN ('queued','running') OR (status='suspended' AND wake_at<=?))) OR
    (owner_token IS NOT NULL AND status IN ('running','suspended')) ORDER BY created_at,rowid`,
};

export function rowToRun(row: RunRow): RunRecord {
  const run: RunRecord = {
    id: row.id,
    slug: row.slug,
    revision: row.revision,
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

  if (row.next_retry_at !== null) {
    run.nextRetryAt = row.next_retry_at;
  }

  if (row.wake_at !== null) {
    run.wakeAt = row.wake_at;
  }

  if (row.owner_token !== null && row.owner_host !== null && row.heartbeat_at !== null) {
    run.owner = {
      token: row.owner_token,
      pid: row.owner_pid,
      host: row.owner_host,
      heartbeatAt: row.heartbeat_at,
    };
  }

  return run;
}

export function rowToSchedule(row: ScheduleRow): Schedule {
  const schedule: Schedule = {
    version: row.version,
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

export function rowToLog(row: LogRow) {
  return decodeLogRecord(row.record);
}

const runSchema = Schema.Struct({
  id: Schema.String,
  slug: Schema.String,
  revision: Schema.String,
  workspace: Schema.String,
  input: jsonSchema,
  status: runStatusSchema,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  output: Schema.optional(jsonSchema),
  error: Schema.optional(Schema.String),
  wakeAt: Schema.optional(Schema.String),
  nextRetryAt: Schema.optional(Schema.String),
  owner: Schema.optional(
    Schema.Struct({
      token: Schema.String,
      pid: Schema.NullOr(Schema.Int),
      host: Schema.String,
      heartbeatAt: Schema.String,
    }),
  ),
});

const eventSchema = Schema.Union([
  Schema.Struct({
    entity: Schema.Literal("hook"),
    kind: Schema.Literals(HOOK_EVENT_KINDS),
    record: hookRecordSchema,
  }),
  Schema.Struct({
    entity: Schema.Literal("run"),
    kind: Schema.Literals(RUN_EVENT_KINDS),
    record: runSchema,
  }),
  Schema.Struct({
    entity: Schema.Literal("node"),
    kind: Schema.Literals(NODE_RUN_STATUSES),
    record: nodeRunSchema,
  }),
  Schema.Struct({
    entity: Schema.Literal("log"),
    kind: Schema.Literal("written"),
    record: logRecordSchema,
  }),
  Schema.Struct({
    entity: Schema.Literal("schedule"),
    kind: Schema.Literals(SCHEDULE_EVENT_KINDS),
    record: scheduleSchema,
  }),
  Schema.Struct({
    entity: Schema.Literal("schedule"),
    kind: Schema.Literal("deleted"),
    record: Schema.Struct({ workspace: Schema.String, slug: Schema.String }),
  }),
]);

export function rowToEvent(row: EventRow) {
  const change = decodeEvent({
    entity: row.entity,
    kind: row.kind,
    record: decodeEventRecord(row.record),
  });

  return { ...change, sequence: row.sequence, at: row.at, txn: row.txn, runId: row.run_id };
}

function decode(text: string) {
  return decodeJson(text);
}

const decodeLogRecord = storedDecoder(logRecordSchema, "logs");

const decodeJson = storedDecoder(jsonSchema, "runs/schedules JSON");

const decodeEvent = storedValueDecoder(eventSchema, "events");

const decodeEventRecord = storedDecoder(Schema.Unknown, "events");
