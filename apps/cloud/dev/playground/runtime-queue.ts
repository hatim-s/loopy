import { appendFile } from "node:fs/promises";
import { resolve } from "node:path";
import { decodeBoundary, encodeBoundary, executionKeySchema } from "@loopy/contract";
import { EXECUTION_ERROR_CODES } from "@loopy/core";
import { Schema } from "effect";

const nonNegative = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0));

export const runtimeOutcomes = ["succeeded", "expired-in-queue", "transport-exception"] as const;

// Outcomes that leave a started effect unresolved; receipt verification refuses them.
export const unresolvedOutcomes = ["uncertain", "transport-exception", "expired-in-queue"] as const;

export const runtimeQueueSchema = Schema.Struct({
  executionKey: executionKeySchema,
  attempt: Schema.Int.check(Schema.isGreaterThan(0)),
  queuedAt: Schema.String,
  acquiredAt: Schema.String,
  finishedAt: Schema.String,
  queueWaitMs: nonNegative,
  backendDurationMs: nonNegative,
  outcome: Schema.Literals([...runtimeOutcomes, ...EXECUTION_ERROR_CODES]),
});

export type RuntimeQueueEntry = typeof runtimeQueueSchema.Type;

export const decodeRuntimeQueue = decodeBoundary(runtimeQueueSchema);

export const runtimeQueuePath = (state: string) => resolve(state, "runtime-queue.jsonl");

export async function appendRuntimeQueue(state: string, entry: RuntimeQueueEntry) {
  await appendFile(
    runtimeQueuePath(state),
    `${JSON.stringify(encodeBoundary(runtimeQueueSchema)(entry))}\n`,
    { mode: 0o600 },
  );
}
