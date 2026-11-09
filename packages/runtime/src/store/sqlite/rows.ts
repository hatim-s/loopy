import {
  hookRecordSchema,
  jsonSchema,
  logRecordSchema,
  nodeRunSchema,
  runStatusSchema,
  scheduleSchema,
} from "@loopy/contract";
import {
  HOOK_EVENT_KINDS,
  NODE_RUN_STATUSES,
  RUN_EVENT_KINDS,
  type RunRecord,
  SCHEDULE_EVENT_KINDS,
  type Schedule,
} from "@loopy/core";
import { Schema } from "effect";
import { storedDecoder, storedValueDecoder } from "../row-codec";
import { waitRecordSchema } from "../wait-schema";

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
  next_retry_at: string | null;
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
  entity: string;
  kind: string;
  run_id: string | null;
  record: string;
};

const decodeJson = storedDecoder(jsonSchema, "runs/schedules JSON");

export const decodeLog = storedDecoder(logRecordSchema, "logs");

export const decodeNodeRun = storedDecoder(nodeRunSchema, "node_runs/node_attempts");

export const decodeWait = storedDecoder(waitRecordSchema, "waits");

export function rowToRun(row: RunRow): RunRecord {
  const run: RunRecord = {
    id: row.id,
    slug: row.slug,
    revision: row.revision,
    workspace: row.workspace,
    input: decodeJson(row.input_json),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };

  if (row.output_json !== null) {
    run.output = decodeJson(row.output_json);
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
    input: decodeJson(row.input_json),
    enabled: row.enabled === 1,
    nextFireAt: row.next_fire_at,
  };

  if (row.last_fire_key !== null) {
    schedule.lastFireKey = row.last_fire_key;
  }

  return schedule;
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

const decodeEvent = storedValueDecoder(eventSchema, "events");

const decodeEventRecord = storedDecoder(Schema.Unknown, "events");

export function rowToEvent(row: EventRow) {
  const change = decodeEvent({
    entity: row.entity,
    kind: row.kind,
    record: decodeEventRecord(row.record),
  });

  return { ...change, sequence: row.sequence, at: row.at, txn: row.txn, runId: row.run_id };
}
