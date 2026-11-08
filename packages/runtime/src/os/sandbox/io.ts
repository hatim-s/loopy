import { rm } from "node:fs/promises";
import type { CommandResult } from "@loopy/core";
import { errnoCode, errorMessage } from "@loopy/core";
import { Data, Effect, Exit } from "effect";
import type { CommandExecutionError } from "../command-error";

export class ProcessFilesystemError extends Data.TaggedError("ProcessFilesystemError")<{
  cause: unknown;
  message: string;
}> {}

/** Foreign filesystem calls cannot be cancelled. Await them before releasing their paths. */
export const filesystem = <A>(body: () => PromiseLike<A>) =>
  Effect.uninterruptible(
    Effect.tryPromise({
      try: body,
      catch: (cause) => new ProcessFilesystemError({ cause, message: errorMessage(cause) }),
    }),
  );

export const absentPath = (error: ProcessFilesystemError) =>
  ["ENOENT", "ENOTDIR", "EACCES"].includes(errnoCode(error.cause) ?? "");

type ScratchOutcome = Exit.Exit<CommandResult, CommandExecutionError | ProcessFilesystemError>;

export class ScratchCleanupError extends Data.TaggedError("ScratchCleanupError")<{
  cause: ProcessFilesystemError;
  primary: ScratchOutcome;
}> {}

export function removeScratch(directory: string, outcome: Exit.Exit<ScratchOutcome>) {
  return filesystem(() => rm(directory, { recursive: true, force: true })).pipe(
    Effect.mapError(
      (cause) =>
        new ScratchCleanupError({
          cause,
          primary: Exit.isSuccess(outcome) ? outcome.value : Exit.failCause(outcome.cause),
        }),
    ),
  );
}
