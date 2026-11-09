import { isDeepStrictEqual } from "node:util";
import type { Json } from "@loopy/contract";

export type Evidence = Record<string, Json>;

export class JourneyFailure extends Error {
  constructor(readonly evidence: Evidence) {
    // Evidence holds no secrets, so the message carries it for callers that record only text.
    super(`Journey assertion failed: ${JSON.stringify(evidence)}`);
  }
}

export function assert<T>(
  condition: T,
  failure: string,
  evidence: Evidence = {},
): asserts condition {
  if (!condition) {
    throw new JourneyFailure({ failure, ...evidence });
  }
}

export function equal<A, B>(actual: A, expected: B, failure: string): void {
  assert(isDeepStrictEqual(actual, expected), failure);
}

export function failureEvidence(cause: unknown): Evidence {
  return cause instanceof JourneyFailure
    ? cause.evidence
    : {
        failure: "unexpected_test_error",
        errorType: cause instanceof Error ? cause.name : "non_error",
      };
}
