import { Schema } from "effect";
import { positiveInt, struct } from "./codec";
import { durationMs, durationSchema } from "./duration";

export const rateLimitSchema = struct({
  key: Schema.String.check(Schema.isMinLength(1)),
  limit: positiveInt,
  window: durationSchema.check(
    Schema.makeFilter((value) => durationMs(value) > 0, {
      message: "Supply a positive rate-limit window.",
    }),
  ),
});

export type RateLimit = Schema.Schema.Type<typeof rateLimitSchema>;

export type RateLimitResult = { ok: true } | { ok: false; retryAt: string };
