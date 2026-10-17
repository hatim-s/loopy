import { z } from "zod";
import { LOG_LEVELS, RUN_STATUSES, STEP_KINDS } from "../core/index.js";
import { jsonSchema } from "./json.js";

// Every counter the engine records is a nonnegative integer; the wire must not loosen that.
const counter = z.number().int().nonnegative();

export const runStatusSchema = z.enum(RUN_STATUSES);

export type RunStatus = z.infer<typeof runStatusSchema>;

export const runOutcomeSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("succeeded"), output: jsonSchema }),
  z.strictObject({ status: z.literal("failed"), error: z.string() }),
  z.strictObject({ status: z.literal("cancelled") }),
]);

export type RunOutcome = z.infer<typeof runOutcomeSchema>;

const stepBaseSchema = z.strictObject({
  runId: z.string(),
  seq: counter,
  key: z.string(),
  kind: z.enum(STEP_KINDS),
  input: jsonSchema,
  attempt: counter,
  maxAttempts: counter,
  startedAt: z.string(),
});

export const stepRecordSchema = z.discriminatedUnion("status", [
  stepBaseSchema.extend({ status: z.literal("running") }),
  stepBaseSchema.extend({
    status: z.literal("succeeded"),
    output: jsonSchema,
    endedAt: z.string(),
    finishOrder: counter,
  }),
  stepBaseSchema.extend({
    status: z.literal("failed"),
    error: z.string(),
    endedAt: z.string(),
    finishOrder: counter,
  }),
  stepBaseSchema.extend({
    status: z.literal("retrying"),
    error: z.string(),
    nextRetryAt: z.string(),
    endedAt: z.string(),
  }),
  stepBaseSchema.extend({ status: z.literal("sleeping"), wakeAt: z.string() }),
  stepBaseSchema.extend({ status: z.literal("waiting"), wakeAt: z.string().optional() }),
]);

export type StepRecord = z.infer<typeof stepRecordSchema>;

export const logPositionSchema = z.discriminatedUnion("kind", [
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

export type LogPosition = z.infer<typeof logPositionSchema>;

export const logRecordSchema = z.strictObject({
  runId: z.string(),
  seq: counter,
  position: logPositionSchema,
  level: z.enum(LOG_LEVELS),
  message: z.string(),
  data: jsonSchema.optional(),
  at: z.string(),
});

export type LogRecord = z.infer<typeof logRecordSchema>;

export const hookRecordSchema = z.strictObject({
  token: z.string(),
  runId: z.string(),
  seq: counter,
  name: z.string(),
  createdAt: z.string(),
  payload: jsonSchema.optional(),
  resolvedAt: z.string().optional(),
  expiredAt: z.string().optional(),
});

export type HookRecord = z.infer<typeof hookRecordSchema>;

export const scheduleSchema = z.strictObject({
  workspace: z.string(),
  slug: z.string(),
  cron: z.string(),
  tz: z.string(),
  input: jsonSchema,
  enabled: z.boolean(),
  lastFireKey: z.string().optional(),
  nextFireAt: z.string(),
});

export type Schedule = z.infer<typeof scheduleSchema>;
