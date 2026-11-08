import { Schema, Tuple } from "effect";
import { counter, struct } from "./codec";
import { executionKeySchema } from "./graph/key";
import { NODE_RUN_STATUSES, nodeRunSchema } from "./graph/node-run";
import { outputSchema } from "./graph/values";
import { jsonSchema } from "./json";

export type CommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
};

export const RUN_STATUSES = [
  "queued",
  "running",
  "suspended",
  "succeeded",
  "failed",
  "cancelled",
] as const;

export const runStatusSchema = Schema.Literals(RUN_STATUSES);

export type RunStatus = Schema.Schema.Type<typeof runStatusSchema>;

export function emptyRunCounts(): Record<RunStatus, number> {
  return { queued: 0, running: 0, suspended: 0, succeeded: 0, failed: 0, cancelled: 0 };
}

export const runOutcomeSchema = Schema.Union([
  struct({ status: Schema.Literal("succeeded"), output: jsonSchema }),
  struct({ status: Schema.Literal("failed"), error: Schema.String }),
  struct({ status: Schema.Literal("cancelled") }),
]);

export type RunOutcome = Schema.Schema.Type<typeof runOutcomeSchema>;

const runBaseSchema = struct({
  id: Schema.String,
  slug: Schema.String,
  revision: Schema.String,
  workspace: Schema.String,
  input: jsonSchema,
  nextRetryAt: Schema.optional(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  owner: Schema.optional(
    struct({
      token: Schema.String,
      pid: Schema.NullOr(Schema.Int),
      host: Schema.String,
      heartbeatAt: Schema.String,
    }),
  ),
});

// A finished run carries its outcome; a suspended run carries the time it next wakes, if any.
export const runRecordSchema = Schema.Union([
  struct({ ...runBaseSchema.fields, status: Schema.Literal("queued") }),
  struct({ ...runBaseSchema.fields, status: Schema.Literal("running") }),
  struct({
    ...runBaseSchema.fields,
    status: Schema.Literal("suspended"),
    wakeAt: Schema.NullOr(Schema.String),
  }),
  ...runOutcomeSchema.mapMembers(Tuple.map(Schema.fieldsAssign(runBaseSchema.fields))).members,
]);

export type RunRecord = Schema.Schema.Type<typeof runRecordSchema>;

export const LOG_LEVELS = ["info", "warn", "error"] as const;

export const logPositionSchema = struct({
  kind: Schema.Literal("node"),
  executionKey: Schema.String,
  attempt: counter,
  index: counter,
});

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

// A hook plus the execution it resumes and the payload schema it accepts.
export const waitRecordSchema = struct({
  ...hookRecordSchema.fields,
  executionKey: executionKeySchema,
  schema: outputSchema,
});

export type WaitRecord = Schema.Schema.Type<typeof waitRecordSchema>;

export type PendingHook = HookRecord & { expiresAt: string | null };

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

const TERMINAL_RUN_STATUSES = [
  "succeeded",
  "failed",
  "cancelled",
] as const satisfies readonly RunStatus[];

export function isTerminalRun(status: RunStatus): boolean {
  return TERMINAL_RUN_STATUSES.some((terminal) => terminal === status);
}

const eventFields = {
  sequence: counter,
  at: Schema.String,
  txn: Schema.String,
  runId: Schema.NullOr(Schema.String),
};

export const runtimeEventSchema = Schema.Union([
  struct({
    ...eventFields,
    entity: Schema.Literal("run"),
    kind: Schema.Literals([
      "created",
      "claimed",
      "heartbeat",
      "suspended",
      "woken",
      "released",
      "finished",
    ]),
    record: runRecordSchema,
  }),
  struct({
    ...eventFields,
    entity: Schema.Literal("node"),
    kind: Schema.Literals(NODE_RUN_STATUSES),
    record: nodeRunSchema,
  }),
  struct({
    ...eventFields,
    entity: Schema.Literal("log"),
    kind: Schema.Literal("written"),
    record: logRecordSchema,
  }),
  struct({
    ...eventFields,
    entity: Schema.Literal("hook"),
    kind: Schema.Literals(["created", "resolved", "expired"]),
    record: hookRecordSchema,
  }),
  struct({
    ...eventFields,
    entity: Schema.Literal("schedule"),
    kind: Schema.Literals(["saved", "fired"]),
    record: scheduleSchema,
  }),
  struct({
    ...eventFields,
    entity: Schema.Literal("schedule"),
    kind: Schema.Literal("deleted"),
    record: struct({ workspace: Schema.String, slug: Schema.String }),
  }),
]);

export type RuntimeEvent = Schema.Schema.Type<typeof runtimeEventSchema>;

export const RUNTIME_EVENT_ENTITIES = [
  "run",
  "node",
  "log",
  "hook",
  "schedule",
] as const satisfies readonly RuntimeEvent["entity"][];

export type RuntimeEventChange<T = RuntimeEvent> = T extends RuntimeEvent
  ? Omit<T, "sequence" | "at" | "txn">
  : never;
