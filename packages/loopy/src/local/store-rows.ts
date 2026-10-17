import { z } from "zod";
import {
  hookRecordSchema,
  jsonSchema,
  logRecordSchema,
  nodeRunSchema,
  runStatusSchema,
  scheduleSchema,
  stepRecordSchema,
} from "../contract/index.js";
import type {
  HookRecord,
  Json,
  LogRecord,
  RunRecord,
  RuntimeEvent,
  Schedule,
  StepRecord,
} from "../core/index.js";
import {
  HOOK_EVENT_KINDS,
  NODE_RUN_STATUSES,
  RUN_EVENT_KINDS,
  SCHEDULE_EVENT_KINDS,
  STEP_STATUSES,
} from "../core/index.js";
import { EVENT_RETENTION } from "../runtime/index.js";
import type {
  EventRow,
  HookRow,
  LogRow,
  RunRow,
  ScheduleRow,
  StepColumns,
  StepRow,
} from "./store-schema.js";

export const SQL = {
  createEpoch: "INSERT INTO meta(key,value) VALUES ('epoch',?)",
  epoch: "SELECT value FROM meta WHERE key='epoch'",
  appendEvent:
    "INSERT INTO events(at,txn,entity,kind,run_id,record) VALUES (?,?,?,?,?,?) RETURNING *",
  events: "SELECT * FROM events WHERE sequence>? ORDER BY sequence LIMIT ?",
  transactionEvents: "SELECT * FROM events WHERE txn=? AND sequence>? ORDER BY sequence",
  cursor: "SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name='events'),0) AS cursor",
  pruneEvents: `DELETE FROM events WHERE at<? OR sequence IN (
    SELECT sequence FROM events ORDER BY sequence DESC LIMIT -1 OFFSET ${EVENT_RETENTION.maxRows}
  )`,
  hookStep: "SELECT * FROM hooks WHERE run_id=? AND seq=?",
  log: "SELECT * FROM logs WHERE run_id=? AND seq=?",
  runningSteps: "SELECT * FROM steps WHERE run_id=? AND status='running' ORDER BY seq",
  hooks: "SELECT * FROM hooks WHERE run_id=? ORDER BY seq",
  pendingHooks: (count: number) =>
    `SELECT * FROM hooks WHERE run_id=? AND seq IN (${Array.from({ length: count }, () => "?").join(",")}) ORDER BY seq`,
  hook: "SELECT * FROM hooks WHERE token=?",
  step: "SELECT * FROM steps WHERE run_id=? AND seq=?",
  createHook: "INSERT INTO hooks(token,run_id,seq,name,created_at) VALUES (?,?,?,?,?)",
  resolveHook: "UPDATE hooks SET payload_json=?,resolved_at=? WHERE token=?",
  wakeHook: "UPDATE runs SET wake_at=?,updated_at=? WHERE id=?",
  expireHook: "UPDATE hooks SET expired_at=? WHERE run_id=? AND seq=?",
  unconsumedHook: `SELECT MIN(h.resolved_at) AS wake_at FROM hooks h JOIN steps s
    ON s.run_id=h.run_id AND s.seq=h.seq
    WHERE h.run_id=? AND h.resolved_at IS NOT NULL AND s.status='waiting'`,
  rateLimit: "SELECT window_start AS windowStart,count FROM rate_limits WHERE key=?",
  putRateLimit:
    "INSERT INTO rate_limits VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET window_start=excluded.window_start,count=excluded.count",
  schedules: "SELECT * FROM schedules ORDER BY rowid",
  schedule: "SELECT * FROM schedules WHERE workspace=? AND slug=?",
  putSchedule: `INSERT INTO schedules VALUES (?,?,?,?,?,?,?,?,1) ON CONFLICT(workspace,slug) DO UPDATE SET
    cron=excluded.cron,tz=excluded.tz,input_json=excluded.input_json,enabled=excluded.enabled,
    last_fire_key=excluded.last_fire_key,next_fire_at=excluded.next_fire_at,revision=schedules.revision+1 RETURNING *`,
  deleteSchedule: "DELETE FROM schedules WHERE workspace=? AND slug=?",
  setScheduleEnabled: `UPDATE schedules SET enabled=?,revision=revision+1,
    next_fire_at=COALESCE(?,next_fire_at) WHERE workspace=? AND slug=? RETURNING *`,
  advanceSchedule: `UPDATE schedules SET next_fire_at=? WHERE workspace=? AND slug=?
    AND revision=? AND enabled=1`,
  fireSchedule: `UPDATE schedules SET last_fire_key=?,next_fire_at=? WHERE workspace=? AND slug=?
    AND revision=? AND enabled=1 AND (last_fire_key IS NULL OR last_fire_key<>?)`,
  nextWakeAt:
    "SELECT MIN(wake_at) AS wake_at FROM runs WHERE status='suspended' AND owner_token IS NULL",
  run: "SELECT * FROM runs WHERE id=?",
  createRun: `INSERT INTO runs VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  listRuns:
    "SELECT * FROM runs WHERE (?1 IS NULL OR slug=?1) AND (?2 IS NULL OR status=?2) ORDER BY rowid",
  claim: `UPDATE runs SET owner_token=?,owner_pid=?,owner_host=?,heartbeat_at=?,updated_at=?,status='running',wake_at=NULL WHERE id=? AND owner_token IS NULL AND status IN ('queued','suspended')`,
  heartbeat: "UPDATE runs SET heartbeat_at=?,updated_at=? WHERE id=? AND owner_token=?",
  suspend:
    "UPDATE runs SET status='suspended',wake_at=?,updated_at=? WHERE id=? AND owner_token=? AND status='running'",
  finish:
    "UPDATE runs SET status=?,output_json=?,error=?,wake_at=NULL,updated_at=? WHERE id=? AND owner_token=? AND status='running'",
  release:
    "UPDATE runs SET wake_at=CASE WHEN status='running' THEN ? ELSE wake_at END,status=CASE WHEN status='running' THEN 'suspended' ELSE status END,owner_token=NULL,owner_pid=NULL,owner_host=NULL,heartbeat_at=NULL,updated_at=? WHERE id=? AND owner_token=?",
  steps: "SELECT * FROM steps WHERE run_id=? ORDER BY seq",
  putStep: `INSERT INTO steps VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(run_id,seq) DO UPDATE SET key=excluded.key,kind=excluded.kind,
    input_json=excluded.input_json,attempt=excluded.attempt,max_attempts=excluded.max_attempts,
    started_at=excluded.started_at,status=excluded.status,output_json=excluded.output_json,
    error=excluded.error,next_retry_at=excluded.next_retry_at,wake_at=excluded.wake_at,
    finish_order=excluded.finish_order,ended_at=excluded.ended_at`,
  appendLog: "INSERT INTO logs VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
  logExists: "SELECT seq FROM logs WHERE run_id=? AND seq=?",
  logs: "SELECT * FROM logs WHERE run_id=? AND seq>? ORDER BY seq",
  dueRuns: `SELECT * FROM runs WHERE (owner_token IS NULL AND
    (status='queued' OR (status='suspended' AND wake_at<=?))) OR
    (owner_token IS NOT NULL AND status='running') ORDER BY created_at,rowid`,
  recoverSteps: `UPDATE steps SET status='retrying',error='Runner lost ownership. Retrying unfinished step.',
    next_retry_at=?,ended_at=? WHERE run_id=? AND status='running'`,
};

function decode(value: string): Json {
  return JSON.parse(value);
}

export function rowToRun(row: RunRow): RunRecord {
  const run: RunRecord = {
    id: row.id,
    slug: row.slug,
    revision: row.bundle_hash,
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

export function rowToStep(row: StepRow): StepRecord {
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
    case "waiting":
      return { ...base, status: row.status, wakeAt: row.wake_at ?? undefined };
  }
}

export function stepToRow(step: StepRecord): StepRow {
  const base: StepColumns = {
    run_id: step.runId,
    seq: step.seq,
    key: step.key,
    kind: step.kind,
    input_json: JSON.stringify(step.input),
    attempt: step.attempt,
    max_attempts: step.maxAttempts,
    started_at: new Date(step.startedAt).toISOString(),
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
        ended_at: new Date(step.endedAt).toISOString(),
        finish_order: step.finishOrder,
      };
    case "failed":
      return {
        ...base,
        status: step.status,
        error: step.error,
        ended_at: new Date(step.endedAt).toISOString(),
        finish_order: step.finishOrder,
      };
    case "retrying":
      return {
        ...base,
        status: step.status,
        error: step.error,
        next_retry_at: new Date(step.nextRetryAt).toISOString(),
        ended_at: new Date(step.endedAt).toISOString(),
      };
    case "sleeping":
      return { ...base, status: step.status, wake_at: new Date(step.wakeAt).toISOString() };
    case "waiting":
      return {
        ...base,
        status: step.status,
        wake_at: step.wakeAt === undefined ? null : new Date(step.wakeAt).toISOString(),
      };
  }
}

export function rowToLog(row: LogRow): LogRecord {
  const log: LogRecord = {
    runId: row.run_id,
    seq: row.seq,
    position: rowToPosition(row),
    level: row.level,
    message: row.message,
    at: row.at,
  };

  if (row.data_json !== null) {
    log.data = decode(row.data_json);
  }

  return log;
}

function rowToPosition(row: LogRow): LogRecord["position"] {
  switch (row.position_kind) {
    case "workflow":
      return {
        kind: row.position_kind,
        afterStep: row.after_step,
        afterFinish: row.after_finish,
        index: row.log_index,
      };
    case "step":
      return {
        kind: row.position_kind,
        seq: row.step_seq,
        attempt: row.attempt,
        index: row.log_index,
      };
  }
}

export function rowToSchedule(row: ScheduleRow): Schedule {
  const schedule: Schedule = {
    revision: row.revision,
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

export function rowToHook(row: HookRow): HookRecord {
  const hook: HookRecord = {
    token: row.token,
    runId: row.run_id,
    seq: row.seq,
    name: row.name,
    createdAt: row.created_at,
  };

  if (row.resolved_at !== null && row.payload_json !== null) {
    hook.resolvedAt = row.resolved_at;
    hook.payload = decode(row.payload_json);
  }

  if (row.expired_at !== null) {
    hook.expiredAt = row.expired_at;
  }

  return hook;
}

const runRecordSchema = z.strictObject({
  id: z.string(),
  slug: z.string(),
  revision: z.string(),
  workspace: z.string(),
  input: jsonSchema,
  status: runStatusSchema,
  output: jsonSchema.optional(),
  error: z.string().optional(),
  wakeAt: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  owner: z
    .strictObject({
      token: z.string(),
      pid: z.number().int().nonnegative(),
      host: z.string(),
      heartbeatAt: z.string(),
    })
    .optional(),
});

const eventBaseSchema = z.strictObject({
  sequence: z.number().int().positive(),
  at: z.string(),
  txn: z.string(),
  runId: z.string().nullable(),
});

const eventRecordSchema = z.discriminatedUnion("entity", [
  eventBaseSchema.extend({
    entity: z.literal("run"),
    kind: z.enum(RUN_EVENT_KINDS),
    record: runRecordSchema,
  }),
  eventBaseSchema.extend({
    entity: z.literal("node"),
    kind: z.enum(NODE_RUN_STATUSES),
    record: nodeRunSchema,
  }),
  eventBaseSchema.extend({
    entity: z.literal("step"),
    kind: z.enum(STEP_STATUSES),
    record: stepRecordSchema,
  }),
  eventBaseSchema.extend({
    entity: z.literal("log"),
    kind: z.literal("written"),
    record: logRecordSchema,
  }),
  eventBaseSchema.extend({
    entity: z.literal("hook"),
    kind: z.enum(HOOK_EVENT_KINDS),
    record: hookRecordSchema,
  }),
  z.discriminatedUnion("kind", [
    eventBaseSchema.extend({
      entity: z.literal("schedule"),
      kind: z.enum(SCHEDULE_EVENT_KINDS),
      record: scheduleSchema,
    }),
    eventBaseSchema.extend({
      entity: z.literal("schedule"),
      kind: z.literal("deleted"),
      record: z.strictObject({ workspace: z.string(), slug: z.string() }),
    }),
  ]),
]);

export function rowToEvent(row: EventRow): RuntimeEvent {
  // BOUNDARY: Persisted event JSON must validate before callers receive typed records.
  return eventRecordSchema.parse({
    sequence: row.sequence,
    at: row.at,
    txn: row.txn,
    runId: row.run_id,
    entity: row.entity,
    kind: row.kind,
    record: JSON.parse(row.record),
  });
}
