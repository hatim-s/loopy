import { z } from "zod";
import { jsonSchema } from "./json.js";
import { logRecordSchema, runStatusSchema } from "./records.js";
import {
  daemonViewSchema,
  loopyViewSchema,
  runSnapshotViewSchema,
  runViewSchema,
  serverEventSchema,
} from "./views.js";

export const ERROR_CODES = [
  "not_found",
  "not_claimable",
  "owned_elsewhere",
  "unknown_hook",
  "bad_request",
  "stale_cursor",
] as const;

export const errorCodeSchema = z.enum(ERROR_CODES);

export type ErrorCode = z.infer<typeof errorCodeSchema>;

export const DEFAULT_ERROR_MESSAGES = {
  not_found: "The requested resource was not found.",
  not_claimable: "The run cannot be claimed in its current state.",
  owned_elsewhere: "Another worker owns this run. Try again after its lease expires.",
  unknown_hook: "The hook is unknown or no longer pending.",
  bad_request: "The request is invalid. Check its parameters and body.",
  stale_cursor: "The event cursor is stale. Fetch a fresh snapshot.",
} satisfies Record<ErrorCode, string>;

export const errorBodySchema = z.object({
  error: z.object({ code: errorCodeSchema, message: z.string() }),
});

export type ErrorBody = z.infer<typeof errorBodySchema>;

const emptySchema = z.object({});

const runParamsSchema = z.object({ id: z.string() });

export const runsQuerySchema = z.object({
  slug: z.string().optional(),
  status: runStatusSchema.optional(),
  limit: z.coerce.number().int().positive().optional(),
  before: z.string().optional(),
});

export const logsQuerySchema = z.object({
  after: z.coerce.number().int().nonnegative().optional(),
});

export const eventsQuerySchema = z.object({
  after: z.coerce.number().int().nonnegative(),
  epoch: z.string(),
});

export const startRunBodySchema = z.object({ input: jsonSchema, workspace: z.string().optional() });

export const resolveHookBodySchema = z.object({ payload: jsonSchema });

type Route = {
  method: "GET" | "POST";
  path: string;
  params: z.ZodObject;
  query: z.ZodObject;
  body: z.ZodType;
  response: z.ZodType;
};

export const routes = {
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
    params: z.object({ slug: z.string() }),
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
    params: z.object({ token: z.string() }),
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
} as const satisfies Record<string, Route>;
