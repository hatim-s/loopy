import type {
  AuthorityError,
  SandboxAttemptAuthority as WireAuthority,
  ImmutableResults as WireResults,
} from "@loopy/contract";
import type { CommandExecutionError } from "@loopy/runtime/local/execution-host";
import { Data, Effect } from "effect";
import type { AttemptConflict, InvalidAttempt } from "./admission";
import type { ArtifactError, ExportCleanupError } from "./artifact-error";

export class SandboxOperationError extends Data.TaggedError("SandboxOperationError")<{
  operation: string;
  cause: unknown;
  message: string;
}> {}

export type SandboxFailure =
  | CommandExecutionError
  | SandboxOperationError
  | AuthorityError
  | ExportCleanupError
  | ArtifactError
  | AttemptConflict
  | InvalidAttempt;

type Native<T, E> = {
  [K in keyof T]: T[K] extends (...args: infer A) => Promise<infer B>
    ? (...args: A) => Effect.Effect<B, E>
    : never;
};

export type SandboxAttemptAuthority = Native<WireAuthority, AuthorityError | SandboxOperationError>;

export type ImmutableResults = Native<WireResults, SandboxOperationError | AuthorityError>;

export type ResultsFor = (workspace: string) => ImmutableResults;

export function failure(
  operation: string,
  cause: unknown,
  message = cause instanceof Error
    ? cause.message
    : `Sandbox ${operation} failed. Inspect durable state before retrying.`,
): SandboxOperationError {
  return cause instanceof SandboxOperationError
    ? cause
    : new SandboxOperationError({ operation, cause, message });
}

// These adapters are for individual filesystem and codec boundaries.
export const io = <A>(operation: string, run: () => PromiseLike<A>) =>
  Effect.tryPromise({ try: run, catch: (cause) => failure(operation, cause) });

export const checked = <A>(operation: string, run: () => A) =>
  Effect.try({ try: run, catch: (cause) => failure(operation, cause) });
