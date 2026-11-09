import { type Diagnostic, errnoCode, errorMessage } from "@loopy/core";
import { Cause, Data, Effect } from "effect";
import type { CompileResult, CompilerDiagnostic, CompilerDiagnosticCode } from "./types";

export class CompilationError extends Data.TaggedError("CompilationError")<{
  operation: string;
  file: string;
  cause: unknown;
}> {
  override get message() {
    return `Could not ${this.operation} '${this.file}'. ${errorMessage(this.cause)}`;
  }
}

export class AuthorDiagnostics extends Data.TaggedError("AuthorDiagnostics")<{
  diagnostics: CompilerDiagnostic[];
}> {}

export function authorFailure(code: CompilerDiagnosticCode, file: string, message: string) {
  return new AuthorDiagnostics({ diagnostics: [{ code, message, file, line: 1, column: 1 }] });
}

/** Graph diagnostics carry no source position, so they point at the entry module. */
export function graphDiagnostics(
  diagnostics: readonly Diagnostic[],
  file: string,
): CompilerDiagnostic[] {
  return diagnostics.map(({ code, message }) => ({ code, message, file, line: 1, column: 1 }));
}

export const compilerIO = <A>(operation: string, file: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new CompilationError({ operation, file, cause }),
  });

export const authorSource = <A>(operation: string, file: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) =>
      errnoCode(cause) === "ENOENT" || errnoCode(cause) === "ENOTDIR"
        ? authorFailure("source_error", file, errorMessage(cause))
        : new CompilationError({ operation, file, cause }),
  });

/** Evaluation and scratch removal can both fail, so a cause with several reasons stays infrastructure. */
export const recoverDiagnostics = <R>(
  operation: Effect.Effect<CompileResult, CompilationError | AuthorDiagnostics, R>,
  file: string,
): Effect.Effect<CompileResult, CompilationError, R> =>
  operation.pipe(
    Effect.catchCause((cause): Effect.Effect<CompileResult, CompilationError> => {
      const reason = cause.reasons.length === 1 ? cause.reasons[0] : undefined;
      const error = reason?._tag === "Fail" ? reason.error : undefined;

      if (error instanceof AuthorDiagnostics) {
        return Effect.succeed({ ok: false, diagnostics: error.diagnostics });
      }

      return Effect.failCause(
        Cause.map(cause, (error) =>
          error instanceof CompilationError
            ? error
            : new CompilationError({ operation: "compile with concurrent failures", file, cause }),
        ),
      );
    }),
  );
