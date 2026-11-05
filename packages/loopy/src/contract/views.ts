import { Schema } from "effect";
import {
  EXECUTION_MODES,
  FIELD_TYPES,
  HOOK_EVENT_KINDS,
  LOOPY_SCOPES,
  NODE_RUN_STATUSES,
  RUN_EVENT_KINDS,
  SCHEDULE_EVENT_KINDS,
  STEP_STATUSES,
} from "../core/index.js";
import { struct } from "./codec.js";

import { scopeCountsSchema } from "./dashboard.js";
import { nodeRunViewSchema } from "./graph.js";
import { jsonSchema } from "./json.js";
import {
  hookRecordSchema,
  logRecordSchema,
  runStatusSchema,
  scheduleSchema,
  stepRecordSchema,
} from "./records.js";

const runBaseSchema = struct({
  id: Schema.String,
  slug: Schema.String,
  workspace: Schema.String,
  loopy: struct({ slug: Schema.String, description: Schema.NullOr(Schema.String) }),
  input: jsonSchema,
  truncatedFields: Schema.optional(
    struct({
      input: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
      output: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
    }),
  ),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  owner: Schema.NullOr(
    struct({
      pid: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
      host: Schema.String,
      heartbeatAt: Schema.String,
    }),
  ),
  ownerStale: Schema.Boolean,
  waitingOn: Schema.NullOr(
    struct({
      hook: Schema.String,
      token: Schema.String,
      seq: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
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
  /** The project root whose registry resolved this entry. Graph and start requests send it back. */

  workspace: Schema.String,
  description: Schema.NullOr(Schema.String),
  scope: Schema.Literals(LOOPY_SCOPES),
  mode: Schema.Literals(EXECUTION_MODES),
  input: Schema.Union([
    Schema.Record(Schema.String, Schema.mutableKey(Schema.Literals(FIELD_TYPES))),
    Schema.Literal("schema"),
  ]),
  schedule: Schema.NullOr(
    struct({
      cron: Schema.String,
      tz: Schema.String,
      enabled: Schema.Boolean,
      nextFireAt: Schema.NullOr(Schema.String),
    }),
  ),
  lastRun: Schema.NullOr(runViewSchema),
  counts: Schema.Record(
    runStatusSchema,
    Schema.mutableKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  ),
  latestRuns: Schema.optional(
    Schema.Array(runViewSchema).pipe(Schema.mutable).check(Schema.isMaxLength(10)),
  ),
});

export type LoopyView = Schema.Schema.Type<typeof loopyViewSchema>;

export const runSnapshotViewSchema = struct({
  run: runViewSchema,
  nodeRuns: Schema.Array(nodeRunViewSchema).pipe(Schema.mutable),
  scopes: Schema.optional(Schema.Array(scopeCountsSchema).pipe(Schema.mutable)),
  nodeRunsNext: Schema.optional(Schema.NullOr(Schema.String)),
  truncatedOutputs: Schema.optional(Schema.Record(Schema.String, Schema.mutableKey(Schema.Finite))),
  hooksTruncated: Schema.optional(Schema.Boolean),
  steps: Schema.Array(stepRecordSchema).pipe(Schema.mutable),
  logs: Schema.Array(logRecordSchema).pipe(Schema.mutable),
  hooks: Schema.Array(hookRecordSchema).pipe(Schema.mutable),
  cursor: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  epoch: Schema.String,
});

export type RunSnapshotView = Schema.Schema.Type<typeof runSnapshotViewSchema>;

export const daemonViewSchema = struct({
  pid: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  startedAt: Schema.String,
  concurrency: Schema.Int.check(Schema.isGreaterThan(0)),
  running: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  nextWakeAt: Schema.NullOr(Schema.String),
});

export type DaemonView = Schema.Schema.Type<typeof daemonViewSchema>;

const eventBaseSchema = struct({
  truncatedOutputBytes: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  sequence: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
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
    record: nodeRunViewSchema,
  }),
  struct({
    ...eventBaseSchema.fields,
    entity: Schema.Literal("step"),
    kind: Schema.Literals(STEP_STATUSES),
    record: stepRecordSchema,
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
  cursor: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  epoch: Schema.String,
});

export type CursorView = Schema.Schema.Type<typeof cursorViewSchema>;
