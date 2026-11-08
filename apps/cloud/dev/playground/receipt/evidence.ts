import {
  attemptId,
  resultBytes,
  resultRef,
  type SandboxAttemptIdentity,
  sameRef,
} from "@loopy/contract/sandbox";
import { Effect } from "effect";
import type { ResultsFor, SandboxAttemptAuthority } from "../../../../sandbox/src/authority";

export function receiptEvidence(options: {
  root: string;
  identity: SandboxAttemptIdentity;
  authority: Pick<SandboxAttemptAuthority, "read">;
  resultsFor: ResultsFor;
}) {
  return Effect.gen(function* () {
    const id = yield* Effect.promise(() => attemptId(options.root, options.identity));
    const record = yield* options.authority.read({ id });

    if (
      !record ||
      record.plan.id !== id ||
      (yield* Effect.promise(() => attemptId(options.root, record.plan))) !== id
    ) {
      return yield* Effect.fail(
        new Error("Authority evidence does not match the requested execution identity."),
      );
    }

    if (record.kind !== "finished" || record.result.kind !== "blob") {
      return yield* Effect.fail(
        new Error("Architecture evidence requires a terminal receipt with immutable result bytes."),
      );
    }

    const result = yield* options.resultsFor(options.identity.workspace).get(record.result.ref);
    const bytes = resultBytes(result);
    const observed = bytes && (yield* Effect.promise(() => resultRef(bytes)));

    if (!observed || !sameRef(observed, record.result.ref)) {
      return yield* Effect.fail(
        new Error("Resolved terminal bytes do not match the authoritative result reference."),
      );
    }

    return {
      receiptMode: "durable-object" as const,
      id,
      identity: options.identity,
      session: record.session,
      requestHash: record.plan.requestHash,
      resultRef: observed,
      resultKind: result.kind,
      resultResolved: true as const,
    };
  });
}
