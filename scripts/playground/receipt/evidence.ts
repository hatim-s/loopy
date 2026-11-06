import { Effect } from "effect";
import { attemptHash } from "../../../apps/sandbox/src/admission";
import { resultReference } from "../../../apps/sandbox/src/immutable-results";
import type { ResultsFor, SandboxAttemptAuthority } from "../../../apps/sandbox/src/operations";
import type { SandboxAttemptIdentity } from "../../../packages/loopy/src/contract";

export function receiptEvidence(options: {
  root: string;
  identity: SandboxAttemptIdentity;
  authority: Pick<SandboxAttemptAuthority, "read">;
  resultsFor: ResultsFor;
}) {
  return Effect.gen(function* () {
    const id = attemptHash({ root: options.root, ...options.identity });
    const record = yield* options.authority.read(id);

    if (
      !record ||
      record.plan.id !== id ||
      attemptHash({
        root: options.root,
        workspace: record.plan.workspace,
        executionKey: record.plan.executionKey,
        attempt: record.plan.attempt,
      }) !== id
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
    const observed = resultReference(result);

    if (observed.sha256 !== record.result.ref.sha256 || observed.size !== record.result.ref.size) {
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
