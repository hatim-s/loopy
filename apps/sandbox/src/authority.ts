import type { ExecutionResult } from "@loopy/contract";
import type {
  AuthorityError,
  AuthorityInput,
  AuthorityOutput,
  authorityOperations,
  ResultRef,
} from "@loopy/contract/sandbox";
import type { Effect } from "effect";
import type { SandboxOperationError } from "./operations";

type AuthorityFailure = AuthorityError | SandboxOperationError;

export type SandboxAttemptAuthority = {
  [K in keyof typeof authorityOperations]: (
    input: AuthorityInput<K>,
  ) => Effect.Effect<AuthorityOutput<K>, AuthorityFailure>;
};

export interface ImmutableResults {
  put(result: ExecutionResult): Effect.Effect<ResultRef, AuthorityFailure>;
  get(ref: ResultRef): Effect.Effect<ExecutionResult, AuthorityFailure>;
}

// Composition binds the workspace before any bytes or digest select storage paths.
export type ResultsFor = (workspace: string) => ImmutableResults;
