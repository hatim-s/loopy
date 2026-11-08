import type { CompilerDiagnostic } from "@loopy/compiler";
import { errorMessage } from "@loopy/core";
import { Data, Effect } from "effect";

export class CliError extends Data.TaggedError("CliError")<{
  message: string;
  cause?: unknown;
}> {}

export const cliSync = <A>(run: () => A) =>
  Effect.try({
    try: run,
    catch: (cause) => new CliError({ message: errorMessage(cause), cause }),
  });

export const cliIO = <A>(run: (signal: AbortSignal) => PromiseLike<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new CliError({ message: errorMessage(cause), cause }),
  });

export const diagnosticsError = (diagnostics: readonly CompilerDiagnostic[]) =>
  new CliError({
    message: diagnostics
      .map(
        (value) => `${value.file}:${value.line}:${value.column} [${value.code}] ${value.message}`,
      )
      .join("\n"),
  });
