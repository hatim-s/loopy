import { Effect } from "effect";
import type { SandboxReceipt } from "../../../packages/loopy/src/contract/index.js";
import type { AttemptRecord } from "../../../packages/loopy/src/contract/sandbox-journal.js";
import type { ResultsFor } from "./operations.js";

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
