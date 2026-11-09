import type { AuthorityInput, AuthorityOutput } from "./authority";
import { sameRef } from "./identity";
import {
  type AttemptRecord,
  type AuthorityFailure,
  type AuthoritySession,
  artifactHelperName,
  type ExportRecord,
  type FinishedAttemptRecord,
  type ResultRef,
} from "./journal";

// Both authorities read these facts inside their own transaction, call the transition, and
// persist the record it returns. Keeping the rules here keeps their rejection codes identical.

const rejected = (code: AuthorityFailure) => ({ kind: "rejected" as const, code });

export function sameSession(left: AuthoritySession, right: AuthoritySession | null) {
  return right !== null && left.epoch === right.epoch && left.nonce === right.nonce;
}

export function admitTransition(
  input: AuthorityInput<"admit">,
  facts: {
    current: AuthoritySession | null;
    validPlan: boolean;
    existing: AttemptRecord | null;
    workspaceBusy: boolean;
  },
): AuthorityOutput<"admit"> {
  if (!sameSession(input.session, facts.current)) {
    return rejected("stale_session");
  }

  if (!facts.validPlan) {
    return rejected("invalid_state");
  }

  if (facts.existing) {
    return facts.existing.plan.requestHash === input.plan.requestHash
      ? { kind: "existing", record: facts.existing }
      : rejected("request_conflict");
  }

  if (facts.workspaceBusy) {
    return rejected("workspace_busy");
  }

  return { kind: "created", record: { kind: "started", plan: input.plan, session: input.session } };
}

/** A `publish` decision asks the caller to verify the result bytes and persist the record. */
export function completeTransition(
  input: AuthorityInput<"complete">,
  facts: {
    current: AuthoritySession | null;
    existing: AttemptRecord | null;
    // Retained legacy filesystem receipts embed their result. The caller supplies its ref.
    inlineRef: ResultRef | null;
  },
): AuthorityOutput<"complete"> | { kind: "publish"; record: FinishedAttemptRecord } {
  if (!sameSession(input.session, facts.current)) {
    return rejected("stale_session");
  }

  const existing = facts.existing;

  if (!existing) {
    return rejected("missing");
  }

  if (existing.plan.requestHash !== input.requestHash) {
    return rejected("request_conflict");
  }

  if (existing.kind === "finished") {
    const stored = existing.result.kind === "blob" ? existing.result.ref : facts.inlineRef;

    return stored && sameRef(stored, input.result)
      ? { kind: "finished", record: existing }
      : rejected("request_conflict");
  }

  return {
    kind: "publish",
    record: { ...existing, kind: "finished", result: { kind: "blob", ref: input.result } },
  };
}

/** A `create` decision asks the caller to persist a new active guard. */
export function beginExportTransition(
  input: AuthorityInput<"beginExport">,
  facts: {
    current: AuthoritySession | null;
    token: { record: ExportRecord; active: boolean } | null;
    attempt: AttemptRecord | null;
    workspaceBusy: (volume: string) => boolean;
  },
): AuthorityOutput<"beginExport"> | { kind: "create"; record: ExportRecord } {
  if (!sameSession(input.session, facts.current)) {
    return rejected("stale_session");
  }

  if (facts.token) {
    if (facts.token.record.attemptId !== input.attemptId) {
      return rejected("request_conflict");
    }

    return facts.token.active
      ? { kind: "granted", record: facts.token.record }
      : rejected("invalid_state");
  }

  const attempt = facts.attempt;

  if (!attempt) {
    return rejected("missing");
  }

  if (attempt.kind !== "finished") {
    return rejected("invalid_state");
  }

  if (facts.workspaceBusy(attempt.plan.volume)) {
    return rejected("workspace_busy");
  }

  return {
    kind: "create",
    record: {
      token: input.token,
      session: input.session,
      attemptId: input.attemptId,
      volume: attempt.plan.volume,
      helper: artifactHelperName(input.attemptId),
    },
  };
}

/**
 * A `release` decision asks the caller to deactivate the guard. An unknown or released token is
 * already in the state a retried release wants, so it is a no-op.
 */
export function endExportTransition(
  input: AuthorityInput<"endExport">,
  facts: { current: AuthoritySession | null; active: boolean },
): { kind: "rejected"; code: AuthorityFailure } | { kind: "release" } | { kind: "released" } {
  if (!sameSession(input.session, facts.current)) {
    return rejected("stale_session");
  }

  return facts.active ? { kind: "release" } : { kind: "released" };
}
