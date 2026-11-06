import { LOG_LEVELS, RUN_STATUSES, STEP_KINDS } from "@loopy/core";
import { Schema } from "effect";
import { struct } from "./codec";

import { jsonSchema } from "./json";

// Every counter the engine records is a nonnegative integer; the wire must not loosen that.
const counter = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const runStatusSchema = Schema.Literals(RUN_STATUSES);

export type RunStatus = Schema.Schema.Type<typeof runStatusSchema>;

export const runOutcomeSchema = Schema.Union([
  struct({ status: Schema.Literal("succeeded"), output: jsonSchema }),
  struct({ status: Schema.Literal("failed"), error: Schema.String }),
  struct({ status: Schema.Literal("cancelled") }),
]);

export type RunOutcome = Schema.Schema.Type<typeof runOutcomeSchema>;

const stepBaseSchema = struct({
  runId: Schema.String,
  seq: counter,
  key: Schema.String,
  kind: Schema.Literals(STEP_KINDS),
  input: jsonSchema,
  attempt: counter,
  maxAttempts: counter,
  startedAt: Schema.String,
});

export const stepRecordSchema = Schema.Union([
  struct({ ...stepBaseSchema.fields, status: Schema.Literal("running") }),
  struct({
    ...stepBaseSchema.fields,
    status: Schema.Literal("succeeded"),
    output: jsonSchema,
    endedAt: Schema.String,
    finishOrder: counter,
  }),
  struct({
    ...stepBaseSchema.fields,
    status: Schema.Literal("failed"),
    error: Schema.String,
    endedAt: Schema.String,
    finishOrder: counter,
  }),
  struct({
    ...stepBaseSchema.fields,
    status: Schema.Literal("retrying"),
    error: Schema.String,
    nextRetryAt: Schema.String,
    endedAt: Schema.String,
  }),
  struct({ ...stepBaseSchema.fields, status: Schema.Literal("sleeping"), wakeAt: Schema.String }),
  struct({
    ...stepBaseSchema.fields,
    status: Schema.Literal("waiting"),
    wakeAt: Schema.optional(Schema.String),
  }),
]);

export type StepRecord = Schema.Schema.Type<typeof stepRecordSchema>;

export const logPositionSchema = Schema.Union([
  struct({
    kind: Schema.Literal("node"),
    executionKey: Schema.String,
    attempt: counter,
    index: counter,
  }),
  struct({
    kind: Schema.Literal("workflow"),
    afterStep: counter,
    afterFinish: counter,
    index: counter,
  }),
  struct({ kind: Schema.Literal("step"), seq: counter, attempt: counter, index: counter }),
]);

export type LogPosition = Schema.Schema.Type<typeof logPositionSchema>;

export const logRecordSchema = struct({
  runId: Schema.String,
  seq: counter,
  position: logPositionSchema,
  level: Schema.Literals(LOG_LEVELS),
  message: Schema.String,
  data: Schema.optional(jsonSchema),
  at: Schema.String,
});

export type LogRecord = Schema.Schema.Type<typeof logRecordSchema>;

export const hookRecordSchema = struct({
  token: Schema.String,
  runId: Schema.String,
  seq: counter,
  name: Schema.String,
  createdAt: Schema.String,
  payload: Schema.optional(jsonSchema),
  resolvedAt: Schema.optional(Schema.String),
  expiredAt: Schema.optional(Schema.String),
});

export type HookRecord = Schema.Schema.Type<typeof hookRecordSchema>;

export const scheduleSchema = struct({
  version: Schema.Int,
  workspace: Schema.String,
  slug: Schema.String,
  cron: Schema.String,
  tz: Schema.String,
  input: jsonSchema,
  enabled: Schema.Boolean,
  lastFireKey: Schema.optional(Schema.String),
  nextFireAt: Schema.String,
});

export type Schedule = Schema.Schema.Type<typeof scheduleSchema>;
