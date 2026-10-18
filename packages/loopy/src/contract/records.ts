import { z } from "zod";
import { LOG_LEVELS, RUN_STATUSES, STEP_KINDS } from "../core/index.js";
import { jsonSchema } from "./json.js";
import { utcTimestamp } from "./primitives.js";

// Every counter the engine records is a nonnegative integer; the wire must not loosen that.
const counter = z.number().int().nonnegative();

export const runStatusSchema = z.enum(RUN_STATUSES);

export const runOutcomeSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("succeeded"), output: jsonSchema }),
  z.strictObject({ status: z.literal("failed"), error: z.string() }),
  z.strictObject({ status: z.literal("cancelled") }),
]);

const stepBaseSchema = z.strictObject({
  runId: z.string(),
  seq: counter,
  key: z.string(),
  kind: z.enum(STEP_KINDS),
  input: jsonSchema,
  attempt: counter,
  maxAttempts: counter,
  startedAt: utcTimestamp,
});

export const stepRecordSchema = z.discriminatedUnion("status", [
  stepBaseSchema.extend({ status: z.literal("running") }),
  stepBaseSchema.extend({
    status: z.literal("succeeded"),
    output: jsonSchema,
    endedAt: utcTimestamp,
    finishOrder: counter,
  }),
  stepBaseSchema.extend({
    status: z.literal("failed"),
    error: z.string(),
    endedAt: utcTimestamp,
    finishOrder: counter,
  }),
  stepBaseSchema.extend({
    status: z.literal("retrying"),
    error: z.string(),
    nextRetryAt: utcTimestamp,
    endedAt: utcTimestamp,
  }),
  stepBaseSchema.extend({ status: z.literal("sleeping"), wakeAt: utcTimestamp }),
  stepBaseSchema.extend({ status: z.literal("waiting"), wakeAt: utcTimestamp.optional() }),
]);

export const logPositionSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("node"),
    executionKey: z.string(),
    attempt: counter,
    index: counter,
  }),
  z.strictObject({
    kind: z.literal("workflow"),
    afterStep: counter,
    afterFinish: counter,
    index: counter,
  }),
  z.strictObject({
    kind: z.literal("step"),
    seq: counter,
    attempt: counter,
    index: counter,
  }),
]);

export const logRecordSchema = z.strictObject({
  runId: z.string(),
  seq: counter,
  position: logPositionSchema,
  level: z.enum(LOG_LEVELS),
  message: z.string(),
  data: jsonSchema.optional(),
  at: utcTimestamp,
});

export const hookRecordSchema = z.strictObject({
  token: z.string(),
  runId: z.string(),
  seq: counter,
  name: z.string(),
  createdAt: utcTimestamp,
  payload: jsonSchema.optional(),
  resolvedAt: utcTimestamp.optional(),
  expiredAt: utcTimestamp.optional(),
});

export const scheduleSchema = z.strictObject({
  version: z.number().int(),
  workspace: z.string(),
  slug: z.string(),
  cron: z.string(),
  tz: z.string(),
  input: jsonSchema,
  enabled: z.boolean(),
  lastFireKey: z.string().optional(),
  nextFireAt: utcTimestamp,
});

export type {
  HookRecord,
  LogPosition,
  LogRecord,
  RunOutcome,
  RunStatus,
  Schedule,
  StepRecord,
} from "../core/index.js";

export const runRecordSchema = z.strictObject({
  id: z.string(),
  slug: z.string(),
  revision: z.string(),
  workspace: z.string(),
  input: jsonSchema,
  status: runStatusSchema,
  output: jsonSchema.optional(),
  error: z.string().optional(),
  wakeAt: utcTimestamp.optional(),
  nextRetryAt: utcTimestamp.optional(),
  createdAt: utcTimestamp,
  updatedAt: utcTimestamp,
  owner: z
    .strictObject({ token: z.string(), pid: counter, host: z.string(), heartbeatAt: utcTimestamp })
    .optional(),
});

export type { RunRecord } from "../core/index.js";
