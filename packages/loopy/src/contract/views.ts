import { z } from "zod";
import {
  EXECUTION_MODES,
  HOOK_EVENT_KINDS,
  RUN_EVENT_KINDS,
  SCHEDULE_EVENT_KINDS,
  STEP_STATUSES,
} from "../core/index.js";
import { jsonSchema } from "./json.js";
import {
  hookRecordSchema,
  logRecordSchema,
  runStatusSchema,
  scheduleSchema,
  stepRecordSchema,
} from "./records.js";

const runBaseSchema = z.strictObject({
  id: z.string(),
  slug: z.string(),
  workspace: z.string(),
  loopy: z.strictObject({ slug: z.string(), description: z.string().nullable() }),
  input: jsonSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  owner: z
    .strictObject({
      pid: z.number().int().nonnegative(),
      host: z.string(),
      heartbeatAt: z.string(),
    })
    .nullable(),
  ownerStale: z.boolean(),
  waitingOn: z
    .strictObject({
      hook: z.string(),
      token: z.string(),
      seq: z.number().int().nonnegative(),
      expiresAt: z.string().nullable(),
    })
    .nullable(),
});

export const runViewSchema = z.discriminatedUnion("status", [
  runBaseSchema.extend({ status: z.literal("queued") }),
  runBaseSchema.extend({ status: z.literal("running") }),
  runBaseSchema.extend({ status: z.literal("cancelled") }),
  runBaseSchema.extend({ status: z.literal("succeeded"), output: jsonSchema }),
  runBaseSchema.extend({ status: z.literal("failed"), error: z.string() }),
  runBaseSchema.extend({ status: z.literal("suspended"), wakeAt: z.string().nullable() }),
]);

export type RunView = z.infer<typeof runViewSchema>;

export const loopyViewSchema = z.strictObject({
  slug: z.string(),
  description: z.string().optional(),
  scope: z.enum(["project", "global"]),
  mode: z.enum(EXECUTION_MODES),
  input: z.union([
    z.record(z.string(), z.enum(["string", "number", "boolean"])),
    z.literal("schema"),
  ]),
  schedule: z
    .strictObject({
      cron: z.string(),
      tz: z.string(),
      enabled: z.boolean(),
      nextFireAt: z.string(),
    })
    .nullable(),
  lastRun: runViewSchema.nullable(),
  counts: z.record(runStatusSchema, z.number().int().nonnegative()),
});

export type LoopyView = z.infer<typeof loopyViewSchema>;

export const runSnapshotViewSchema = z.strictObject({
  run: runViewSchema,
  steps: z.array(stepRecordSchema),
  logs: z.array(logRecordSchema),
  hooks: z.array(hookRecordSchema),
  cursor: z.number().int().nonnegative(),
  epoch: z.string(),
});

export type RunSnapshotView = z.infer<typeof runSnapshotViewSchema>;

export const daemonViewSchema = z.strictObject({
  pid: z.number().int().nonnegative(),
  startedAt: z.string(),
  concurrency: z.number().int().positive(),
  running: z.number().int().nonnegative(),
  nextWakeAt: z.string().nullable(),
});

export type DaemonView = z.infer<typeof daemonViewSchema>;

const eventBaseSchema = z.strictObject({
  sequence: z.number().int().nonnegative(),
  at: z.string(),
  txn: z.string(),
  runId: z.string().nullable(),
});

export const serverEventSchema = z.discriminatedUnion("entity", [
  eventBaseSchema.extend({
    entity: z.literal("run"),
    kind: z.enum(RUN_EVENT_KINDS),
    record: runViewSchema,
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

export type ServerEvent = z.infer<typeof serverEventSchema>;
