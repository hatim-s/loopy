import { Effect, Schema, SchemaGetter, SchemaIssue } from "effect";
import { LOG_LEVELS, NODE_RUN_STATUSES } from "../core/index.js";
import { decodeBoundary, isoDateTime, queryNumber, struct } from "./codec.js";
import { executionKeySchema, nodeRunViewSchema } from "./graph.js";
import { logRecordSchema, runStatusSchema } from "./records.js";

const iso = isoDateTime;

const limit = queryNumber
  .check(Schema.isInt())
  .check(Schema.isGreaterThan(0))
  .check(Schema.isLessThanOrEqualTo(200))
  .pipe(Schema.withDecodingDefault(Effect.succeed(50)));

const numericCursor = Schema.optional(
  queryNumber.check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0)),
);

export const runFilterFields = {
  slug: Schema.optional(Schema.String),
  workspace: Schema.optional(Schema.String),
  status: Schema.optional(runStatusSchema),
  from: Schema.optional(iso),
  to: Schema.optional(iso),
};

export const statusCountsSchema = Schema.Record(
  runStatusSchema,
  Schema.mutableKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
);

export const nodeCountsSchema = Schema.Record(
  Schema.Literals(NODE_RUN_STATUSES),
  Schema.mutableKey(Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)))),
);

export const scopeCountsSchema = struct({
  nodeId: Schema.String,
  parentScope: executionKeySchema.fields.scope,
  total: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  totalKind: Schema.optional(Schema.Literal("materialized")),
  counts: nodeCountsSchema,
});

const scope = Schema.String.pipe(
  Schema.withDecodingDefault(Effect.succeed("[]")),
  Schema.decodeTo(Schema.String, {
    decode: SchemaGetter.transformEffect((value) =>
      Effect.try({
        try: () =>
          JSON.stringify(decodeBoundary(executionKeySchema.fields.scope)(JSON.parse(value))),
        catch: () =>
          new SchemaIssue.InvalidValue({
            message: "Scope must be a JSON array of {nodeId,index} tuples.",
          }),
      }),
    ),
    encode: SchemaGetter.passthrough(),
  }),
);

export const executionQuerySchema = struct({
  scope,
  nodeId: Schema.optional(Schema.String),
  status: Schema.optional(Schema.Literals(NODE_RUN_STATUSES)),
  after: Schema.optional(Schema.String),
  limit,
});

export const executionDetailQuerySchema = struct({
  key: Schema.String,
  attemptsAfter: numericCursor,
});

export const executionPageSchema = struct({
  items: Schema.Array(nodeRunViewSchema).pipe(Schema.mutable),
  next: Schema.NullOr(Schema.String),
  truncatedOutputs: Schema.Record(
    Schema.String,
    Schema.mutableKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  ),
});

export const executionDetailSchema = struct({
  node: nodeRunViewSchema,
  attempts: Schema.Array(nodeRunViewSchema).pipe(Schema.mutable),
  attemptsNext: Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0))),
  truncatedAttempts: Schema.optional(
    Schema.Record(
      Schema.String,
      Schema.mutableKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
    ),
  ),
});

export const scopeItemsQuerySchema = struct({
  nodeId: Schema.String,
  parentScope: scope,
  after: numericCursor,
  limit,
  status: Schema.optional(Schema.Literals(NODE_RUN_STATUSES)),
});

export const scopeItemsPageSchema = struct({
  items: Schema.Array(
    struct({ index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)), counts: nodeCountsSchema }),
  ).pipe(Schema.mutable),
  next: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
});

export const overviewQuerySchema = struct({
  ...runFilterFields,
  from: iso,
  to: iso,
  bucketSeconds: queryNumber
    .check(Schema.isInt())
    .check(Schema.isGreaterThanOrEqualTo(60))
    .pipe(Schema.withDecodingDefault(Effect.succeed(3600))),
}).check(
  Schema.makeFilter(
    (query) =>
      Date.parse(query.to) > Date.parse(query.from) &&
      Math.ceil((Date.parse(query.to) - Date.parse(query.from)) / (query.bucketSeconds * 1000)) <=
        744,
    { message: "Window must contain between 1 and 744 buckets." },
  ),
);

export const overviewSchema = struct({
  from: iso,
  to: iso,
  bucketSeconds: Schema.Finite,
  counts: statusCountsSchema,
  buckets: Schema.Array(struct({ at: iso, counts: statusCountsSchema })).pipe(Schema.mutable),
});

const feedFilterFields = {
  ...runFilterFields,
  before: numericCursor,
  after: numericCursor,
  limit,
  runId: Schema.optional(Schema.String),
  nodeId: Schema.optional(Schema.String),
};

export const globalLogsQuerySchema = struct({
  ...feedFilterFields,
  level: Schema.optional(Schema.Literals(LOG_LEVELS)),
  text: Schema.optional(Schema.String.check(Schema.isMaxLength(256))),
  executionKey: Schema.optional(Schema.String),
}).check(
  Schema.makeFilter((query) => query.before === undefined || query.after === undefined, {
    message: "Use before or after, not both.",
  }),
);

export const eventHistoryQuerySchema = struct({
  ...feedFilterFields,
  entity: Schema.optional(Schema.Literals(["run", "node", "step", "log", "hook", "schedule"])),
  kind: Schema.optional(Schema.String),
  txn: Schema.optional(Schema.String),
}).check(
  Schema.makeFilter((query) => query.before === undefined || query.after === undefined, {
    message: "Use before or after, not both.",
  }),
);

export const logSummarySchema = struct({
  id: Schema.Int.check(Schema.isGreaterThan(0)),
  runId: Schema.String,
  slug: Schema.String,
  seq: Schema.Int.check(Schema.isGreaterThan(0)),
  at: Schema.String,
  nodeId: Schema.String,
  executionKey: Schema.String,
  attempt: Schema.Int.check(Schema.isGreaterThan(0)),
  level: Schema.Literals(LOG_LEVELS),
  message: Schema.String,
  dataBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});

export const eventSummarySchema = struct({
  sequence: Schema.Int.check(Schema.isGreaterThan(0)),
  at: Schema.String,
  txn: Schema.String,
  runId: Schema.NullOr(Schema.String),
  slug: Schema.NullOr(Schema.String),
  nodeId: Schema.NullOr(Schema.String),
  entity: Schema.Literals(["run", "node", "step", "log", "hook", "schedule"]),
  kind: Schema.String,
});

const feedCursorFields = {
  oldestAt: Schema.optional(Schema.NullOr(Schema.String)),
  newestAt: Schema.optional(Schema.NullOr(Schema.String)),
  scannedToAt: Schema.optional(Schema.NullOr(Schema.String)),
  next: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  scanned: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  hasMore: Schema.Boolean,
  oldest: Schema.NullOr(Schema.Int),
  newest: Schema.NullOr(Schema.Int),
};

export const globalLogsPageSchema = struct({
  ...feedCursorFields,
  items: Schema.Array(logSummarySchema).pipe(Schema.mutable),
});

export const eventHistoryPageSchema = struct({
  ...feedCursorFields,
  items: Schema.Array(eventSummarySchema).pipe(Schema.mutable),
});

export const logDetailSchema = struct({
  id: Schema.Int.check(Schema.isGreaterThan(0)),
  log: logRecordSchema,
});

export type OverviewView = Schema.Schema.Type<typeof overviewSchema>;

export type ScopeCountsView = Schema.Schema.Type<typeof scopeCountsSchema>;

export type ExecutionPage = Schema.Schema.Type<typeof executionPageSchema>;

export type ExecutionDetail = Schema.Schema.Type<typeof executionDetailSchema>;

export type ScopeItemsPage = Schema.Schema.Type<typeof scopeItemsPageSchema>;

export type GlobalLogsPage = Schema.Schema.Type<typeof globalLogsPageSchema>;

export type EventHistoryPage = Schema.Schema.Type<typeof eventHistoryPageSchema>;

export type LogSummaryView = Schema.Schema.Type<typeof logSummarySchema>;

export type EventSummaryView = Schema.Schema.Type<typeof eventSummarySchema>;

export const scheduleSummarySchema = struct({
  workspace: Schema.String,
  slug: Schema.String,
  cron: Schema.String,
  tz: Schema.String,
  nextFireAt: iso,
});

export const scheduleOverviewSchema = struct({
  workspaces: Schema.Array(Schema.String).pipe(Schema.mutable),
  active: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  next: Schema.Array(scheduleSummarySchema).pipe(Schema.mutable).check(Schema.isMaxLength(10)),
});

export type ScheduleOverviewView = Schema.Schema.Type<typeof scheduleOverviewSchema>;

export const scopesQuerySchema = struct({ parentScope: scope });
