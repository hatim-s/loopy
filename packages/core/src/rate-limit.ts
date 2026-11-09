import { Schema } from "effect";
import { positiveInt, struct } from "./codec";
import { positiveDurationSchema } from "./duration";

export const rateLimitSchema = struct({
  key: Schema.String.check(Schema.isMinLength(1)),
  limit: positiveInt,
  window: positiveDurationSchema,
});

export type RateLimit = Schema.Schema.Type<typeof rateLimitSchema>;

export type RateLimitResult = { ok: true } | { ok: false; retryAt: string };
