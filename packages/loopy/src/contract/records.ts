import { z } from "zod";
import { LOG_LEVELS, RUN_STATUSES, STEP_KINDS } from "../core/index.js";
import { jsonSchema } from "./json.js";

export const runStatusSchema = z.enum(RUN_STATUSES);

export type RunStatus = z.infer<typeof runStatusSchema>;

export const runOutcomeSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("succeeded"), output: jsonSchema }),
  z.object({ status: z.literal("failed"), error: z.string() }),
  z.object({ status: z.literal("cancelled") }),
]);

export type RunOutcome = z.infer<typeof runOutcomeSchema>;

const stepBaseSchema = z.object({
  runId: z.string(),
  seq: z.number(),
  key: z.string(),
  kind: z.enum(STEP_KINDS),
  input: jsonSchema,
  attempt: z.number(),
  maxAttempts: z.number(),
  startedAt: z.string(),
});

export const stepRecordSchema = z.discriminatedUnion("status", [
  stepBaseSchema.extend({ status: z.literal("running") }),
  stepBaseSchema.extend({
    status: z.literal("succeeded"),
    output: jsonSchema,
    endedAt: z.string(),
    finishOrder: z.number(),
  }),
  stepBaseSchema.extend({
    status: z.literal("failed"),
    error: z.string(),
    endedAt: z.string(),
    finishOrder: z.number(),
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
  z.object({
    kind: z.literal("workflow"),
    afterStep: z.number(),
    afterFinish: z.number(),
    index: z.number(),
  }),
  z.object({ kind: z.literal("step"), seq: z.number(), attempt: z.number(), index: z.number() }),
]);

export type LogPosition = z.infer<typeof logPositionSchema>;

export const logRecordSchema = z.object({
  runId: z.string(),
  seq: z.number(),
  position: logPositionSchema,
  level: z.enum(LOG_LEVELS),
  message: z.string(),
  data: jsonSchema.optional(),
  at: z.string(),
});

export type LogRecord = z.infer<typeof logRecordSchema>;

export const hookRecordSchema = z.object({
  token: z.string(),
  runId: z.string(),
  seq: z.number(),
  name: z.string(),
  createdAt: z.string(),
  payload: jsonSchema.optional(),
  resolvedAt: z.string().optional(),
  expiredAt: z.string().optional(),
});

export type HookRecord = z.infer<typeof hookRecordSchema>;

export const scheduleSchema = z.object({
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
