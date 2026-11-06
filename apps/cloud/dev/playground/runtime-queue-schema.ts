import { decodeBoundary, executionKeySchema } from "@loopy/contract";
import { Schema } from "effect";

export const runtimeQueueSchema = Schema.Struct({
  executionKey: executionKeySchema,
  attempt: Schema.Int.check(Schema.isGreaterThan(0)),
  queuedAt: Schema.String,
  acquiredAt: Schema.String,
  finishedAt: Schema.String,
  queueWaitMs: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
  backendDurationMs: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
  outcome: Schema.String,
});

export const decodeRuntimeQueue = decodeBoundary(runtimeQueueSchema);
