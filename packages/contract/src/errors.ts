import { struct } from "@loopy/core";
import { Schema } from "effect";

export const ERROR_CODES = [
  "not_yet",
  "not_found",
  "not_claimable",
  "conflict",
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

const errorCodeSchema = Schema.Literals(ERROR_CODES);

export type ErrorCode = Schema.Schema.Type<typeof errorCodeSchema>;

export const DEFAULT_ERROR_MESSAGES = {
  not_yet: "This operation is not implemented yet.",
  not_found: "The requested resource was not found.",
  not_claimable: "The run cannot be claimed in its current state.",
  conflict: "The resource is busy. Retry after the current operation finishes.",
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

export const errorBodySchema = struct({
  error: struct({ code: errorCodeSchema, message: Schema.String }),
});

export type ErrorBody = Schema.Schema.Type<typeof errorBodySchema>;

export const ERROR_STATUS = {
  not_yet: 501,
  not_found: 404,
  unknown_hook: 404,
  not_claimable: 409,
  conflict: 409,
  owned_elsewhere: 409,
  bad_request: 400,
  invalid_schedule: 400,
  stale_cursor: 410,
  unauthorized: 401,
  forbidden: 403,
  internal: 500,
  invalid_cron: 400,
  invalid_timezone: 400,
} as const satisfies Record<ErrorCode, number>;
