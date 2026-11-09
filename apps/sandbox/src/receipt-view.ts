import type { Receipt } from "@loopy/contract";
import type { AttemptRecord, FinishedAttemptRecord } from "@loopy/contract/sandbox";
import { Effect } from "effect";
import type { ResultsFor } from "./authority";

export function resolveResult(resultsFor: ResultsFor, record: FinishedAttemptRecord) {
  // Inline results exist only in retained legacy receipts. See the README exit condition.
  return record.result.kind === "inline"
    ? Effect.succeed(record.result.value)
    : resultsFor(record.plan.workspace).get(record.result.ref);
}

export function publicReceipt(resultsFor: ResultsFor, record: AttemptRecord | null) {
  return Effect.gen(function* () {
    if (record === null) {
      return { kind: "none" } satisfies Receipt;
    }

    if (record.kind === "started") {
      return { kind: "started" } satisfies Receipt;
    }

    return {
      kind: "finished",
      result: yield* resolveResult(resultsFor, record),
    } satisfies Receipt;
  });
}
