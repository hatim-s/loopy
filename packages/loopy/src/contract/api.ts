import { z } from "zod";
import { jsonSchema } from "./json.js";
import { logRecordSchema, runStatusSchema } from "./records.js";
import {
  cursorViewSchema,
  daemonViewSchema,
  loopyViewSchema,
  runSnapshotViewSchema,
  runViewSchema,
  scheduleViewSchema,
  serverEventSchema,
} from "./views.js";

export const ERROR_CODES = [
  "not_found",
  "not_claimable",
  "owned_elsewhere",
  "unknown_hook",
  "bad_request",
  "invalid_schedule",
  "stale_cursor",
  "unauthorized",
  "forbidden",
  "internal",
  "invalid_cron",
  "invalid_timezone",
] as const;

export const errorCodeSchema = z.enum(ERROR_CODES);

export type ErrorCode = z.infer<typeof errorCodeSchema>;

export const DEFAULT_ERROR_MESSAGES = {
  not_found: "The requested resource was not found.",
  not_claimable: "The run cannot be claimed in its current state.",
  owned_elsewhere: "Another worker owns this run. Try again after its lease expires.",
  unknown_hook: "The hook is unknown or no longer pending.",
  bad_request: "The request is invalid. Check its parameters and body.",
  invalid_schedule: "The schedule is invalid. Check its cron expression, timezone and input.",
  stale_cursor: "The event cursor is stale. Fetch a fresh snapshot.",
  unauthorized: "Open the viewer URL printed by loopy ui to authenticate.",
  forbidden: "Cross-origin access is disabled.",
  internal: "An internal server error occurred.",
  invalid_cron: "The cron expression is invalid. Provide five valid fields or a supported alias.",
  invalid_timezone: "The time zone is invalid. Provide an IANA time zone such as Asia/Kolkata.",
} satisfies Record<ErrorCode, string>;

export const errorBodySchema = z.strictObject({
  error: z.strictObject({ code: errorCodeSchema, message: z.string() }),
});

export type ErrorBody = z.infer<typeof errorBodySchema>;

const emptySchema = z.strictObject({});

const runParamsSchema = z.strictObject({ id: z.string() });

export const runsQuerySchema = z.strictObject({
  slug: z.string().optional(),
  status: runStatusSchema.optional(),
  waiting: z
    .union([z.boolean(), z.enum(["true", "false"]).transform((value) => value === "true")])
    .optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
  before: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\|[^|]+$/)
    .optional(),
});

export type RunsQuery = z.infer<typeof runsQuerySchema>;

/** The ID breaks timestamp ties so every run remains reachable. */
export function encodeRunCursor(run: { createdAt: string; id: string }): string {
  return `${run.createdAt}|${run.id}`;
}

export function decodeRunCursor(cursor: NonNullable<RunsQuery["before"]>) {
  const separator = cursor.indexOf("|");

  return { createdAt: cursor.slice(0, separator), id: cursor.slice(separator + 1) };
}

export const logsQuerySchema = z.strictObject({
  after: z.coerce.number().int().nonnegative().optional(),
});

export const eventsQuerySchema = z.strictObject({
  after: z.coerce.number().int().nonnegative(),
  epoch: z.string(),
});

export const startRunBodySchema = z.strictObject({
  input: jsonSchema,
  workspace: z.string().optional(),
});

export const resolveHookBodySchema = z.strictObject({ payload: jsonSchema });

export const putScheduleBodySchema = z.strictObject({
  cron: z.string().optional(),
  tz: z.string().optional(),
  input: jsonSchema.optional(),
  enabled: z.boolean().optional(),
});

export type PutScheduleBody = z.infer<typeof putScheduleBodySchema>;

export const scheduleEnabledBodySchema = z.strictObject({ enabled: z.boolean() });

const scheduleParamsSchema = z.strictObject({ slug: z.string() });

type Route = {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  params: z.ZodObject;
  query: z.ZodObject;
  body: z.ZodType;
  response: z.ZodType;
};

export const routes = {
  schedules: {
    method: "GET",
    path: "/schedules",
    params: emptySchema,
    query: emptySchema,
    body: z.undefined(),
    response: z.array(scheduleViewSchema),
  },
  putSchedule: {
    method: "PUT",
    path: "/loopies/:slug/schedule",
    params: scheduleParamsSchema,
    query: emptySchema,
    body: putScheduleBodySchema,
    response: scheduleViewSchema,
  },
  setScheduleEnabled: {
    method: "POST",
    path: "/loopies/:slug/schedule/enabled",
    params: scheduleParamsSchema,
    query: emptySchema,
    body: scheduleEnabledBodySchema,
    response: scheduleViewSchema,
  },
  deleteSchedule: {
    method: "DELETE",
    path: "/loopies/:slug/schedule",
    params: scheduleParamsSchema,
    query: emptySchema,
    body: z.undefined(),
    response: z.strictObject({ deleted: z.literal(true) }),
  },
  loopies: {
    method: "GET",
    path: "/loopies",
    params: emptySchema,
    query: emptySchema,
    body: z.undefined(),
    response: z.array(loopyViewSchema),
  },
  runs: {
    method: "GET",
    path: "/runs",
    params: emptySchema,
    query: runsQuerySchema,
    body: z.undefined(),
    response: z.array(runViewSchema),
  },
  run: {
    method: "GET",
    path: "/runs/:id",
    params: runParamsSchema,
    query: emptySchema,
    body: z.undefined(),
    response: runSnapshotViewSchema,
  },
  logs: {
    method: "GET",
    path: "/runs/:id/logs",
    params: runParamsSchema,
    query: logsQuerySchema,
    body: z.undefined(),
    response: z.array(logRecordSchema),
  },
  startRun: {
    method: "POST",
    path: "/loopies/:slug/runs",
    params: z.strictObject({ slug: z.string() }),
    query: emptySchema,
    body: startRunBodySchema,
    response: runViewSchema,
  },
  resumeRun: {
    method: "POST",
    path: "/runs/:id/resume",
    params: runParamsSchema,
    query: emptySchema,
    body: z.undefined(),
    response: runViewSchema,
  },
  cancelRun: {
    method: "POST",
    path: "/runs/:id/cancel",
    params: runParamsSchema,
    query: emptySchema,
    body: z.undefined(),
    response: runViewSchema,
  },
  resolveHook: {
    method: "POST",
    path: "/hooks/:token",
    params: z.strictObject({ token: z.string() }),
    query: emptySchema,
    body: resolveHookBodySchema,
    response: runViewSchema,
  },
  daemon: {
    method: "GET",
    path: "/daemon",
    params: emptySchema,
    query: emptySchema,
    body: z.undefined(),
    response: daemonViewSchema,
  },
  events: {
    method: "GET",
    path: "/events",
    params: emptySchema,
    query: eventsQuerySchema,
    body: z.undefined(),
    response: serverEventSchema,
  },
  cursor: {
    method: "GET",
    path: "/cursor",
    params: emptySchema,
    query: emptySchema,
    body: z.undefined(),
    response: cursorViewSchema,
  },
} as const satisfies Record<string, Route>;
