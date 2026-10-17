import type {
  HookRecord,
  Json,
  LogRecord,
  RunRecord,
  RuntimeEvent,
  Schedule,
  StepBase,
  StepRecord,
} from "../core/index.js";
import {
  HOOK_EVENT_KINDS,
  isBoolean,
  isNumber,
  RUN_EVENT_KINDS,
  requireOneOf,
  requireRecord,
  requireString,
  SCHEDULE_EVENT_KINDS,
  STEP_STATUSES,
} from "../core/index.js";
import { assertJson } from "../runtime/index.js";
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
    SELECT sequence FROM events ORDER BY sequence DESC LIMIT -1 OFFSET 100000
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
  putSchedule: `INSERT INTO schedules VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(workspace,slug) DO UPDATE SET
    cron=excluded.cron,tz=excluded.tz,input_json=excluded.input_json,enabled=excluded.enabled,
    last_fire_key=excluded.last_fire_key,next_fire_at=excluded.next_fire_at`,
  deleteSchedule: "DELETE FROM schedules WHERE workspace=? AND slug=?",
  fireSchedule: "UPDATE schedules SET last_fire_key=?,next_fire_at=? WHERE workspace=? AND slug=?",
  nextWakeAt:
    "SELECT MIN(wake_at) AS wake_at FROM runs WHERE status='suspended' AND owner_token IS NULL",
  run: "SELECT * FROM runs WHERE id=?",
  createRun: `INSERT INTO runs VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  listRuns: "SELECT * FROM runs ORDER BY rowid",
  listRunsBySlug: "SELECT * FROM runs WHERE slug=? ORDER BY rowid",
  listRunsByStatus: "SELECT * FROM runs WHERE status=? ORDER BY rowid",
  listRunsBySlugAndStatus: "SELECT * FROM runs WHERE slug=? AND status=? ORDER BY rowid",
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
    bundleHash: row.bundle_hash,
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

type ParsedRecord = ReturnType<typeof requireRecord>;

function text(record: ParsedRecord, key: string): string {
  return requireString(record[key], `Event record.${key}`);
}

function optionalText(record: ParsedRecord, key: string): string | undefined {
  return record[key] === undefined ? undefined : text(record, key);
}

function number(record: ParsedRecord, key: string): number {
  const value = record[key];

  if (!isNumber(value) || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Event record.${key} must be a nonnegative integer.`);
  }

  return value;
}

function json(record: ParsedRecord, key: string): Json {
  const value = record[key];
  assertJson(value, `Event record.${key}`);

  return value;
}

function eventRun(record: ParsedRecord): RunRecord {
  const run: RunRecord = {
    id: text(record, "id"),
    slug: text(record, "slug"),
    bundleHash: text(record, "bundleHash"),
    workspace: text(record, "workspace"),
    input: json(record, "input"),
    status: requireOneOf(
      record.status,
      ["queued", "running", "suspended", "succeeded", "failed", "cancelled"],
      "Event run status",
    ),
    createdAt: text(record, "createdAt"),
    updatedAt: text(record, "updatedAt"),
  };

  if (record.output !== undefined) {
    run.output = json(record, "output");
  }

  if (record.error !== undefined) {
    run.error = text(record, "error");
  }

  if (record.wakeAt !== undefined) {
    run.wakeAt = text(record, "wakeAt");
  }

  if (record.owner !== undefined) {
    run.owner = eventOwner(requireRecord(record.owner, "Event run owner"));
  }

  return run;
}

function eventOwner(owner: ParsedRecord): NonNullable<RunRecord["owner"]> {
  return {
    token: text(owner, "token"),
    pid: number(owner, "pid"),
    host: text(owner, "host"),
    heartbeatAt: text(owner, "heartbeatAt"),
  };
}

function eventStepBase(record: ParsedRecord): StepBase {
  return {
    runId: text(record, "runId"),
    seq: number(record, "seq"),
    key: text(record, "key"),
    kind: requireOneOf(
      record.kind,
      ["command", "function", "sleep", "hook", "clock", "random"],
      "Event step kind",
    ),
    input: json(record, "input"),
    attempt: number(record, "attempt"),
    maxAttempts: number(record, "maxAttempts"),
    startedAt: text(record, "startedAt"),
  };
}

function eventStep(record: ParsedRecord): StepRecord {
  const base = eventStepBase(record);
  const status = requireOneOf(record.status, STEP_STATUSES, "Event step status");

  switch (status) {
    case "running":
      return { ...base, status };
    case "succeeded":
      return {
        ...base,
        status,
        output: json(record, "output"),
        endedAt: text(record, "endedAt"),
        finishOrder: number(record, "finishOrder"),
      };
    case "failed":
      return {
        ...base,
        status,
        error: text(record, "error"),
        endedAt: text(record, "endedAt"),
        finishOrder: number(record, "finishOrder"),
      };
    case "retrying":
      return {
        ...base,
        status,
        error: text(record, "error"),
        endedAt: text(record, "endedAt"),
        nextRetryAt: text(record, "nextRetryAt"),
      };
    case "sleeping":
      return { ...base, status, wakeAt: text(record, "wakeAt") };
    case "waiting":
      return { ...base, status, wakeAt: optionalText(record, "wakeAt") };
  }
}

function eventLog(record: ParsedRecord): LogRecord {
  const position = requireRecord(record.position, "Event log position");
  const kind = requireOneOf(position.kind, ["workflow", "step"], "Event log position kind");

  const log: LogRecord = {
    runId: text(record, "runId"),
    seq: number(record, "seq"),
    position:
      kind === "workflow"
        ? {
            kind,
            afterStep: number(position, "afterStep"),
            afterFinish: number(position, "afterFinish"),
            index: number(position, "index"),
          }
        : {
            kind,
            seq: number(position, "seq"),
            attempt: number(position, "attempt"),
            index: number(position, "index"),
          },
    level: requireOneOf(record.level, ["info", "warn", "error"], "Event log level"),
    message: text(record, "message"),
    at: text(record, "at"),
  };

  if (record.data !== undefined) {
    log.data = json(record, "data");
  }

  return log;
}

function eventHook(record: ParsedRecord): HookRecord {
  const hook: HookRecord = {
    token: text(record, "token"),
    runId: text(record, "runId"),
    seq: number(record, "seq"),
    name: text(record, "name"),
    createdAt: text(record, "createdAt"),
  };

  if (record.payload !== undefined) {
    hook.payload = json(record, "payload");
  }

  if (record.resolvedAt !== undefined) {
    hook.resolvedAt = text(record, "resolvedAt");
  }

  if (record.expiredAt !== undefined) {
    hook.expiredAt = text(record, "expiredAt");
  }

  return hook;
}

function eventSchedule(record: ParsedRecord): Schedule {
  if (!isBoolean(record.enabled)) {
    throw new Error("Event schedule.enabled must be a boolean.");
  }

  const schedule: Schedule = {
    workspace: text(record, "workspace"),
    slug: text(record, "slug"),
    cron: text(record, "cron"),
    tz: text(record, "tz"),
    input: json(record, "input"),
    enabled: record.enabled,
    nextFireAt: text(record, "nextFireAt"),
  };

  if (record.lastFireKey !== undefined) {
    schedule.lastFireKey = text(record, "lastFireKey");
  }

  return schedule;
}

export function rowToEvent(row: EventRow): RuntimeEvent {
  // BOUNDARY: Persisted event JSON must validate before callers receive typed records.
  const record = requireRecord(JSON.parse(row.record), "Event record");
  const base = { sequence: row.sequence, at: row.at, txn: row.txn, runId: row.run_id };

  const entity = row.entity;

  switch (entity) {
    case "run":
      return {
        ...base,
        entity,
        kind: requireOneOf(row.kind, RUN_EVENT_KINDS, "Event run kind"),
        record: eventRun(record),
      };
    case "step":
      return {
        ...base,
        entity,
        kind: requireOneOf(row.kind, STEP_STATUSES, "Event step kind"),
        record: eventStep(record),
      };
    case "log":
      return logEvent(row, record);
    case "hook":
      return {
        ...base,
        entity,
        kind: requireOneOf(row.kind, HOOK_EVENT_KINDS, "Event hook kind"),
        record: eventHook(record),
      };
    case "schedule":
      return scheduleEvent(row, record);
    default:
      throw new Error(`Unknown event entity '${entity}'. Restore the event store.`);
  }
}

function scheduleEvent(
  row: EventRow,
  record: ParsedRecord,
): Extract<RuntimeEvent, { entity: "schedule" }> {
  const kind = requireOneOf(row.kind, [...SCHEDULE_EVENT_KINDS, "deleted"], "Event schedule kind");

  return kind === "deleted"
    ? {
        sequence: row.sequence,
        at: row.at,
        txn: row.txn,
        runId: row.run_id,
        entity: "schedule",
        kind,
        record: { workspace: text(record, "workspace"), slug: text(record, "slug") },
      }
    : {
        sequence: row.sequence,
        at: row.at,
        txn: row.txn,
        runId: row.run_id,
        entity: "schedule",
        kind,
        record: eventSchedule(record),
      };
}

function logEvent(row: EventRow, record: ParsedRecord): Extract<RuntimeEvent, { entity: "log" }> {
  return {
    sequence: row.sequence,
    at: row.at,
    txn: row.txn,
    runId: row.run_id,
    entity: "log",
    kind: requireOneOf(row.kind, ["written"], "Event log kind"),
    record: eventLog(record),
  };
}
