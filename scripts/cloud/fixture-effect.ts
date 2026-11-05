import { Data, Effect } from "effect";
import { JourneyFailure } from "./journey-client.js";

export class FixtureError extends Data.TaggedError("FixtureError")<{
  operation: string;
  cause: unknown;
  message: string;
}> {}

export const fixtureIO = <A>(operation: string, run: () => PromiseLike<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) =>
      cause instanceof JourneyFailure
        ? cause
        : new FixtureError({ operation, cause, message: `Transport fixture ${operation} failed.` }),
  });

export function fixtureFailure(cause: unknown) {
  const error = cause instanceof FixtureError && cause.cause instanceof Error ? cause.cause : cause;

  return {
    failure: error instanceof Error ? error.message : "Unexpected fixture error.",
    failureEvidence: error instanceof JourneyFailure ? error.evidence : undefined,
  };
}
