import type { AuthorityError } from "@loopy/contract/sandbox";
import type { CommandExecutionError } from "@loopy/runtime/local/execution-host";
import { Data, Effect } from "effect";
import type { ExportCleanupError, SandboxRequestError } from "./request-error";

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
  | SandboxRequestError;

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

export const io = <A>(operation: string, run: () => PromiseLike<A>) =>
  Effect.tryPromise({ try: run, catch: (cause) => failure(operation, cause) });

export const checked = <A>(operation: string, run: () => A) =>
  Effect.try({ try: run, catch: (cause) => failure(operation, cause) });
