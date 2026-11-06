import { Data, Effect } from "effect";
import { errnoCode, errorMessage } from "../../core";

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
