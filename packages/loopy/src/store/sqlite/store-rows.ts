import { z } from "zod";
import {
  hookRecordSchema,
  jsonSchema,
  logRecordSchema,
  nodeRunSchema,
  runStatusSchema,
  scheduleSchema,
} from "../../contract/index.js";
import {
  HOOK_EVENT_KINDS,
  NODE_RUN_STATUSES,
  RUN_EVENT_KINDS,
  type RunRecord,
  SCHEDULE_EVENT_KINDS,
  type Schedule,
} from "../../core/index.js";
import { EVENT_RETENTION } from "../event-outbox.js";
import type { EventRow, LogRow, RunRow, ScheduleRow } from "./store-schema.js";

export const SQL = {
  createEpoch: "INSERT INTO meta VALUES ('epoch',?)",
  epoch: "SELECT value FROM meta WHERE key='epoch'",
  appendEvent:
    "INSERT INTO events(at,txn,entity,kind,run_id,record) VALUES (?,?,?,?,?,?) RETURNING *",
  events: "SELECT * FROM events WHERE sequence>? ORDER BY sequence LIMIT ?",
  transactionEvents: "SELECT * FROM events WHERE txn=? AND sequence>? ORDER BY sequence",
  cursor: "SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name='events'),0) AS cursor",
  pruneEvents: `DELETE FROM events WHERE at<? OR sequence IN (SELECT sequence FROM events ORDER BY sequence DESC LIMIT -1 OFFSET ${EVENT_RETENTION.maxRows})`,
  wakeRun: "UPDATE runs SET wake_at=?,updated_at=? WHERE id=?",
  rateLimit: "SELECT window_start AS windowStart,count FROM rate_limits WHERE key=?",
  putRateLimit:
    "INSERT INTO rate_limits VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET window_start=excluded.window_start,count=excluded.count",
  putNode: `INSERT INTO node_runs VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(run_id,execution_key) DO UPDATE SET attempt=excluded.attempt,status=excluded.status,started_at=excluded.started_at,finished_at=excluded.finished_at,output=excluded.output,error=excluded.error,receipt=excluded.receipt,record=excluded.record`,
  appendLog: "INSERT INTO logs VALUES (?,?,?,?,?,?)",
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
  createRun: `INSERT INTO runs VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
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
  return logRecordSchema.parse(JSON.parse(row.record));
}

const runSchema = z
  .object({
    id: z.string(),
    slug: z.string(),
    revision: z.string(),
    workspace: z.string(),
    input: jsonSchema,
    status: runStatusSchema,
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .extend({
    output: jsonSchema.optional(),
    error: z.string().optional(),
    wakeAt: z.string().optional(),
    nextRetryAt: z.string().optional(),
    owner: z
      .strictObject({
        token: z.string(),
        pid: z.number().int(),
        host: z.string(),
        heartbeatAt: z.string(),
      })
      .optional(),
  })
  .strict();

const eventSchema = z.union([
  z.object({ entity: z.literal("hook"), kind: z.enum(HOOK_EVENT_KINDS), record: hookRecordSchema }),
  z.object({ entity: z.literal("run"), kind: z.enum(RUN_EVENT_KINDS), record: runSchema }),
  z.object({ entity: z.literal("node"), kind: z.enum(NODE_RUN_STATUSES), record: nodeRunSchema }),
  z.object({ entity: z.literal("log"), kind: z.literal("written"), record: logRecordSchema }),
  z.object({
    entity: z.literal("schedule"),
    kind: z.enum(SCHEDULE_EVENT_KINDS),
    record: scheduleSchema,
  }),
  z.object({
    entity: z.literal("schedule"),
    kind: z.literal("deleted"),
    record: z.object({ workspace: z.string(), slug: z.string() }),
  }),
]);

export function rowToEvent(row: EventRow) {
  const change = eventSchema.parse({
    entity: row.entity,
    kind: row.kind,
    record: JSON.parse(row.record),
  });

  return { ...change, sequence: row.sequence, at: row.at, txn: row.txn, runId: row.run_id };
}

function decode(text: string) {
  return jsonSchema.parse(JSON.parse(text));
}
