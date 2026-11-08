import { jsonSchema, logRecordSchema, secretValueSchema, struct } from "@loopy/core";
import { Schema, SchemaGetter } from "effect";
import { pageLimit, queryCounter, queryNumber } from "./codec";
import { putLoopyBodySchema } from "./compiled-loopy";
import {
  eventHistoryPageSchema,
  eventHistoryQuerySchema,
  executionDetailQuerySchema,
  executionDetailSchema,
  executionPageSchema,
  executionQuerySchema,
  globalLogsPageSchema,
  globalLogsQuerySchema,
  logDetailSchema,
  overviewQuerySchema,
  overviewSchema,
  runFilterFields,
  scheduleOverviewSchema,
  scopeCountsSchema,
  scopeItemsPageSchema,
  scopeItemsQuerySchema,
  scopesQuerySchema,
} from "./dashboard";
import { PAGE_LIMIT } from "./dashboard-reader";
import { graphRevisionViewSchema, graphViewSchema } from "./graph";
import { sourceArtifactSchema } from "./source-artifact";
import {
  cursorViewSchema,
  daemonViewSchema,
  loopyViewSchema,
  runSnapshotViewSchema,
  runViewSchema,
  scheduleViewSchema,
  serverEventSchema,
} from "./views";

const emptySchema = Schema.Record(Schema.String, Schema.Never);

const workspaceQuerySchema = struct({ workspace: Schema.optional(Schema.String) });

const runParamsSchema = struct({ id: Schema.String });

export const runsQuerySchema = struct({
  ...runFilterFields,
  waiting: Schema.optional(
    Schema.Union([
      Schema.Boolean,
      Schema.Literals(["true", "false"]).pipe(
        Schema.decodeTo(Schema.Boolean, {
          decode: SchemaGetter.transform((value) => value === "true"),
          encode: SchemaGetter.transform((value) =>
            value ? ("true" as const) : ("false" as const),
          ),
        }),
      ),
    ]),
  ),
  limit: pageLimit(50),
  before: Schema.optional(
    Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\|[^|]+$/)),
  ),
});

export type RunsQuery = Schema.Codec.Encoded<typeof runsQuerySchema>;

// The ID breaks timestamp ties so every run remains reachable.
export function encodeRunCursor(run: { createdAt: string; id: string }): string {
  return `${run.createdAt}|${run.id}`;
}

export function decodeRunCursor(cursor: NonNullable<RunsQuery["before"]>) {
  const separator = cursor.indexOf("|");

  return { createdAt: cursor.slice(0, separator), id: cursor.slice(separator + 1) };
}

const logsQuerySchema = struct({
  limit: pageLimit(PAGE_LIMIT),
  after: Schema.optional(queryCounter),
});

const eventsQuerySchema = struct({ after: queryCounter, epoch: Schema.String });

const startRunBodySchema = struct({
  input: jsonSchema,
  workspace: Schema.optional(Schema.String),
});

const resolveHookBodySchema = struct({ payload: jsonSchema });

export const putScheduleBodySchema = struct({
  cron: Schema.optional(Schema.String),
  tz: Schema.optional(Schema.String),
  input: Schema.optional(jsonSchema),
  enabled: Schema.optional(Schema.Boolean),
});

export type PutScheduleBody = Schema.Schema.Type<typeof putScheduleBodySchema>;

export const scheduleEnabledBodySchema = struct({ enabled: Schema.Boolean });

const scheduleParamsSchema = struct({ slug: Schema.String });

/** The local daemon listens here unless the caller picks another port. */
export const DEFAULT_PORT = 4310;

export type Route = {
  readonly method: "GET" | "POST" | "PUT" | "DELETE";
  readonly path: string;
  readonly params: Schema.Codec<Readonly<Record<string, string | number>>, unknown>;
  readonly query: Schema.Codec<object, object>;
  readonly body: Schema.Codec<unknown, unknown>;
  readonly response: Schema.Codec<unknown, unknown>;
};

export const routes = {
  runPayload: {
    method: "GET",
    path: "/runs/:id/payload",
    params: runParamsSchema,
    query: emptySchema,
    body: Schema.Undefined,
    response: struct({ input: jsonSchema, output: Schema.optional(jsonSchema) }),
  },
  scopes: {
    method: "GET",
    path: "/runs/:id/scopes",
    params: runParamsSchema,
    query: scopesQuerySchema,
    body: Schema.Undefined,
    response: Schema.Array(scopeCountsSchema).pipe(Schema.mutable),
  },
  overview: {
    method: "GET",
    path: "/overview",
    params: emptySchema,
    query: overviewQuerySchema,
    body: Schema.Undefined,
    response: overviewSchema,
  },
  executions: {
    method: "GET",
    path: "/runs/:id/executions",
    params: runParamsSchema,
    query: executionQuerySchema,
    body: Schema.Undefined,
    response: executionPageSchema,
  },
  execution: {
    method: "GET",
    path: "/runs/:id/execution",
    params: runParamsSchema,
    query: executionDetailQuerySchema,
    body: Schema.Undefined,
    response: executionDetailSchema,
  },
  scopeItems: {
    method: "GET",
    path: "/runs/:id/scope-items",
    params: runParamsSchema,
    query: scopeItemsQuerySchema,
    body: Schema.Undefined,
    response: scopeItemsPageSchema,
  },
  globalLogs: {
    method: "GET",
    path: "/logs",
    params: emptySchema,
    query: globalLogsQuerySchema,
    body: Schema.Undefined,
    response: globalLogsPageSchema,
  },
  log: {
    method: "GET",
    path: "/logs/:id",
    params: struct({ id: queryNumber.check(Schema.isInt()).check(Schema.isGreaterThan(0)) }),
    query: emptySchema,
    body: Schema.Undefined,
    response: logDetailSchema,
  },
  eventHistory: {
    method: "GET",
    path: "/event-history",
    params: emptySchema,
    query: eventHistoryQuerySchema,
    body: Schema.Undefined,
    response: eventHistoryPageSchema,
  },
  event: {
    method: "GET",
    path: "/event-history/:sequence",
    params: struct({ sequence: queryNumber.check(Schema.isInt()).check(Schema.isGreaterThan(0)) }),
    query: emptySchema,
    body: Schema.Undefined,
    response: serverEventSchema,
  },
  source: {
    method: "GET",
    path: "/loopies/:slug/source",
    params: scheduleParamsSchema,
    query: workspaceQuerySchema,
    body: Schema.Undefined,
    response: sourceArtifactSchema,
  },
  runSource: {
    method: "GET",
    path: "/runs/:id/source",
    params: runParamsSchema,
    query: emptySchema,
    body: Schema.Undefined,
    response: sourceArtifactSchema,
  },
  secrets: {
    method: "GET",
    path: "/secrets",
    params: emptySchema,
    query: emptySchema,
    body: Schema.Undefined,
    response: Schema.Array(Schema.String).pipe(Schema.mutable),
  },
  putSecret: {
    method: "PUT",
    path: "/secrets/:name",
    params: struct({ name: Schema.String }),
    query: emptySchema,
    body: struct({ value: secretValueSchema }),
    response: struct({ name: Schema.String, saved: Schema.Literal(true) }),
  },
  deleteSecret: {
    method: "DELETE",
    path: "/secrets/:name",
    params: struct({ name: Schema.String }),
    query: emptySchema,
    body: Schema.Undefined,
    response: struct({ name: Schema.String, removed: Schema.Literal(true) }),
  },
  generateTypes: {
    method: "POST",
    path: "/types",
    params: emptySchema,
    query: emptySchema,
    body: struct({
      binary: Schema.String,
      path: Schema.Array(Schema.String).pipe(Schema.mutable),
      name: Schema.NullOr(Schema.String),
    }),
    response: struct({
      source: Schema.String,
      warnings: Schema.Array(Schema.String).pipe(Schema.mutable),
      help: Schema.String,
    }),
  },
  resolveNamedHook: {
    method: "POST",
    path: "/runs/:id/hooks/:name",
    params: struct({ id: Schema.String, name: Schema.String }),
    query: emptySchema,
    body: resolveHookBodySchema,
    response: runViewSchema,
  },
  putLoopy: {
    method: "PUT",
    path: "/loopies/:slug",
    params: scheduleParamsSchema,
    query: emptySchema,
    body: putLoopyBodySchema,
    response: graphViewSchema,
  },
  graph: {
    method: "GET",
    path: "/loopies/:slug/graph",
    params: scheduleParamsSchema,
    query: struct({ workspace: Schema.optional(Schema.String) }),
    body: Schema.Undefined,
    response: graphRevisionViewSchema,
  },
  runGraph: {
    method: "GET",
    path: "/runs/:id/graph",
    params: runParamsSchema,
    query: emptySchema,
    body: Schema.Undefined,
    response: graphRevisionViewSchema,
  },
  scheduleOverview: {
    method: "GET",
    path: "/schedules/overview",
    params: emptySchema,
    query: emptySchema,
    body: Schema.Undefined,
    response: scheduleOverviewSchema,
  },
  schedules: {
    method: "GET",
    path: "/schedules",
    params: emptySchema,
    query: workspaceQuerySchema,
    body: Schema.Undefined,
    response: Schema.Array(scheduleViewSchema).pipe(Schema.mutable),
  },
  putSchedule: {
    method: "PUT",
    path: "/loopies/:slug/schedule",
    params: scheduleParamsSchema,
    query: workspaceQuerySchema,
    body: putScheduleBodySchema,
    response: scheduleViewSchema,
  },
  setScheduleEnabled: {
    method: "POST",
    path: "/loopies/:slug/schedule/enabled",
    params: scheduleParamsSchema,
    query: workspaceQuerySchema,
    body: scheduleEnabledBodySchema,
    response: scheduleViewSchema,
  },
  deleteSchedule: {
    method: "DELETE",
    path: "/loopies/:slug/schedule",
    params: scheduleParamsSchema,
    query: workspaceQuerySchema,
    body: Schema.Undefined,
    response: struct({ deleted: Schema.Literal(true) }),
  },
  loopies: {
    method: "GET",
    path: "/loopies",
    params: emptySchema,
    query: workspaceQuerySchema,
    body: Schema.Undefined,
    response: Schema.Array(loopyViewSchema).pipe(Schema.mutable),
  },
  runs: {
    method: "GET",
    path: "/runs",
    params: emptySchema,
    query: runsQuerySchema,
    body: Schema.Undefined,
    response: Schema.Array(runViewSchema).pipe(Schema.mutable),
  },
  run: {
    method: "GET",
    path: "/runs/:id",
    params: runParamsSchema,
    query: emptySchema,
    body: Schema.Undefined,
    response: runSnapshotViewSchema,
  },
  logs: {
    method: "GET",
    path: "/runs/:id/logs",
    params: runParamsSchema,
    query: logsQuerySchema,
    body: Schema.Undefined,
    response: Schema.Array(logRecordSchema).pipe(Schema.mutable),
  },
  startRun: {
    method: "POST",
    path: "/loopies/:slug/runs",
    params: struct({ slug: Schema.String }),
    query: emptySchema,
    body: startRunBodySchema,
    response: runViewSchema,
  },
  resumeRun: {
    method: "POST",
    path: "/runs/:id/resume",
    params: runParamsSchema,
    query: emptySchema,
    body: Schema.Undefined,
    response: runViewSchema,
  },
  cancelRun: {
    method: "POST",
    path: "/runs/:id/cancel",
    params: runParamsSchema,
    query: emptySchema,
    body: Schema.Undefined,
    response: runViewSchema,
  },
  resolveHook: {
    method: "POST",
    path: "/hooks/:token",
    params: struct({ token: Schema.String }),
    query: emptySchema,
    body: resolveHookBodySchema,
    response: runViewSchema,
  },
  daemon: {
    method: "GET",
    path: "/daemon",
    params: emptySchema,
    query: emptySchema,
    body: Schema.Undefined,
    response: daemonViewSchema,
  },
  events: {
    method: "GET",
    path: "/events",
    params: emptySchema,
    query: eventsQuerySchema,
    body: Schema.Undefined,
    response: serverEventSchema,
  },
  cursor: {
    method: "GET",
    path: "/cursor",
    params: emptySchema,
    query: emptySchema,
    body: Schema.Undefined,
    response: cursorViewSchema,
  },
} as const satisfies Record<string, Route>;
