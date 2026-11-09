import {
  counter,
  EXECUTION_MODES,
  HOOK_EVENT_KINDS,
  hookRecordSchema,
  jsonSchema,
  LOOPY_SCOPES,
  logRecordSchema,
  NODE_RUN_STATUSES,
  nodeRunSchema,
  positiveInt,
  RUN_EVENT_KINDS,
  recordSpecSchema,
  runStatusSchema,
  SCHEDULE_EVENT_KINDS,
  scheduleSchema,
  struct,
} from "@loopy/core";
import { Schema } from "effect";
import { scopeCountsSchema } from "./dashboard";

const runBaseSchema = struct({
  id: Schema.String,
  slug: Schema.String,
  workspace: Schema.String,
  loopy: struct({ slug: Schema.String, description: Schema.NullOr(Schema.String) }),
  input: jsonSchema,
  truncatedFields: Schema.optional(
    struct({ input: Schema.optional(counter), output: Schema.optional(counter) }),
  ),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  owner: Schema.NullOr(
    struct({
      pid: Schema.NullOr(counter),
      host: Schema.String,
      heartbeatAt: Schema.String,
    }),
  ),
  ownerStale: Schema.Boolean,
  waitingOn: Schema.NullOr(
    struct({
      hook: Schema.String,
      token: Schema.String,
      seq: counter,
      expiresAt: Schema.NullOr(Schema.String),
      since: Schema.String,
    }),
  ),
});

export const runViewSchema = Schema.Union([
  struct({ ...runBaseSchema.fields, status: Schema.Literal("queued") }),
  struct({ ...runBaseSchema.fields, status: Schema.Literal("running") }),
  struct({ ...runBaseSchema.fields, status: Schema.Literal("cancelled") }),
  struct({ ...runBaseSchema.fields, status: Schema.Literal("succeeded"), output: jsonSchema }),
  struct({ ...runBaseSchema.fields, status: Schema.Literal("failed"), error: Schema.String }),
  struct({
    ...runBaseSchema.fields,
    status: Schema.Literal("suspended"),
    wakeAt: Schema.NullOr(Schema.String),
  }),
]);

export type RunView = Schema.Schema.Type<typeof runViewSchema>;

export const scheduleViewSchema = struct({
  ...scheduleSchema.fields,
  lastFireKey: Schema.NullOr(Schema.String),
});

export type ScheduleView = Schema.Schema.Type<typeof scheduleViewSchema>;

export const loopyViewSchema = struct({
  slug: Schema.String,
  // The project root whose registry resolved this entry; graph and start requests send it back.
  workspace: Schema.String,
  description: Schema.NullOr(Schema.String),
  scope: Schema.Literals(LOOPY_SCOPES),
  mode: Schema.Literals(EXECUTION_MODES),
  input: Schema.Union([recordSpecSchema, Schema.Literal("schema")]),
  schedule: Schema.NullOr(
    struct({
      cron: Schema.String,
      tz: Schema.String,
      enabled: Schema.Boolean,
      nextFireAt: Schema.NullOr(Schema.String),
    }),
  ),
  lastRun: Schema.NullOr(runViewSchema),
  counts: Schema.Record(runStatusSchema, Schema.mutableKey(counter)),
  latestRuns: Schema.optional(
    Schema.Array(runViewSchema).pipe(Schema.mutable).check(Schema.isMaxLength(10)),
  ),
});

export type LoopyView = Schema.Schema.Type<typeof loopyViewSchema>;

export const runSnapshotViewSchema = struct({
  run: runViewSchema,
  nodeRuns: Schema.Array(nodeRunSchema).pipe(Schema.mutable),
  scopes: Schema.optional(Schema.Array(scopeCountsSchema).pipe(Schema.mutable)),
  nodeRunsNext: Schema.optional(Schema.NullOr(Schema.String)),
  truncatedOutputs: Schema.optional(Schema.Record(Schema.String, Schema.mutableKey(Schema.Finite))),
  hooksTruncated: Schema.optional(Schema.Boolean),
  logs: Schema.Array(logRecordSchema).pipe(Schema.mutable),
  hooks: Schema.Array(hookRecordSchema).pipe(Schema.mutable),
  cursor: counter,
  epoch: Schema.String,
});

export type RunSnapshotView = Schema.Schema.Type<typeof runSnapshotViewSchema>;

export const daemonViewSchema = struct({
  pid: Schema.NullOr(counter),
  startedAt: Schema.String,
  concurrency: positiveInt,
  running: counter,
  nextWakeAt: Schema.NullOr(Schema.String),
});

export type DaemonView = Schema.Schema.Type<typeof daemonViewSchema>;

const eventBaseSchema = struct({
  truncatedOutputBytes: Schema.optional(counter),
  sequence: counter,
  at: Schema.String,
  txn: Schema.String,
  runId: Schema.NullOr(Schema.String),
});

export const serverEventSchema = Schema.Union([
  struct({
    ...eventBaseSchema.fields,
    entity: Schema.Literal("run"),
    kind: Schema.Literals(RUN_EVENT_KINDS),
    record: runViewSchema,
  }),
  struct({
    ...eventBaseSchema.fields,
    entity: Schema.Literal("node"),
    kind: Schema.Literals(NODE_RUN_STATUSES),
    record: nodeRunSchema,
  }),
  struct({
    ...eventBaseSchema.fields,
    entity: Schema.Literal("log"),
    kind: Schema.Literal("written"),
    record: logRecordSchema,
  }),
  struct({
    ...eventBaseSchema.fields,
    entity: Schema.Literal("hook"),
    kind: Schema.Literals(HOOK_EVENT_KINDS),
    record: hookRecordSchema,
  }),
  Schema.Union([
    struct({
      ...eventBaseSchema.fields,
      entity: Schema.Literal("schedule"),
      kind: Schema.Literals(SCHEDULE_EVENT_KINDS),
      record: scheduleSchema,
    }),
    struct({
      ...eventBaseSchema.fields,
      entity: Schema.Literal("schedule"),
      kind: Schema.Literal("deleted"),
      record: struct({ workspace: Schema.String, slug: Schema.String }),
    }),
  ]),
]);

export type ServerEvent = Schema.Schema.Type<typeof serverEventSchema>;

export const cursorViewSchema = struct({
  cursor: counter,
  epoch: Schema.String,
});

export type CursorView = Schema.Schema.Type<typeof cursorViewSchema>;
