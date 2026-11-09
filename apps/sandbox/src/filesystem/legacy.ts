import { decodeBoundary, executionResultSchema } from "@loopy/contract";
import { type AttemptRecord, dockerAttemptPlanSchema } from "@loopy/contract/sandbox";
import { struct } from "@loopy/core";
import { Schema } from "effect";

// Retained datasets still hold flat receipts with inline results. The README lists the exit condition.
const legacyReceiptSchema = Schema.Union([
  struct({ ...dockerAttemptPlanSchema.fields, kind: Schema.Literal("started") }),
  struct({
    ...dockerAttemptPlanSchema.fields,
    kind: Schema.Literal("finished"),
    result: executionResultSchema,
  }),
]);

const legacySession = { epoch: 1, nonce: "legacy-filesystem-recovery" };

// BOUNDARY: Retained receipt JSON is checked against the flat legacy receipt schema.
export function legacyRecord(value: unknown): AttemptRecord {
  const legacy = decodeBoundary(legacyReceiptSchema)(value);

  const plan = {
    id: legacy.id,
    requestHash: legacy.requestHash,
    workspace: legacy.workspace,
    executionKey: legacy.executionKey,
    attempt: legacy.attempt,
    container: legacy.container,
    inputVolume: legacy.inputVolume,
    volume: legacy.volume,
    deadline: legacy.deadline,
  };

  return legacy.kind === "started"
    ? { kind: "started", plan, session: legacySession }
    : {
        kind: "finished",
        plan,
        session: legacySession,
        result: { kind: "inline", value: legacy.result },
      };
}
