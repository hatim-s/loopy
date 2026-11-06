import type { AttemptRecord, SandboxReceipt } from "@loopy/contract";
import { Effect } from "effect";
import type { ResultsFor } from "./operations";

export function publicReceipt(resultsFor: ResultsFor, record: AttemptRecord | null) {
  return Effect.gen(function* () {
    if (record === null) {
      return { kind: "none" } satisfies SandboxReceipt;
    }

    if (record.kind === "started") {
      return { kind: "started" } satisfies SandboxReceipt;
    }

    const result =
      record.result.kind === "inline"
        ? record.result.value
        : yield* resultsFor(record.plan.workspace).get(record.result.ref);

    return { kind: "finished", result } satisfies SandboxReceipt;
  });
}
