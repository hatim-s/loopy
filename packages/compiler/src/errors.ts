import { type Diagnostic, errnoCode, errorMessage } from "@loopy/core";
import { Cause, Data, Effect } from "effect";
import type { CompileResult } from "./types";

/** Compiler infrastructure failures are distinct from author diagnostics. */
export class CompilationError extends Data.TaggedError("CompilationError")<{
  operation: string;
  file: string;
  cause: unknown;
}> {
  override get message() {
    return `Could not ${this.operation} '${this.file}'. ${errorMessage(this.cause)}`;
  }
}

export class AuthorError extends Data.TaggedError("AuthorError")<{
  code: "source_error" | "evaluation_failed" | "bundle_failed";
  file: string;
  message: string;
}> {}

export const compilerIO = <A>(operation: string, file: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new CompilationError({ operation, file, cause }),
  });

export class EvaluationError extends Data.TaggedError("EvaluationError")<{
  diagnostic: Diagnostic;
}> {
  override get message() {
    return this.diagnostic.message;
  }
}

/** Missing author dependencies are source diagnostics; other read errors remain infrastructure failures. */
export const authorSource = <A>(operation: string, file: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) =>
      errnoCode(cause) === "ENOENT" || errnoCode(cause) === "ENOTDIR"
        ? new AuthorError({ code: "source_error", file, message: errorMessage(cause) })
        : new CompilationError({ operation, file, cause }),
  });

/** Combined failures retain the full original Cause inside CompilationError, with defects and interrupts intact. */
export const recoverDiagnostics = <R>(
  operation: Effect.Effect<CompileResult, CompilationError | AuthorError | EvaluationError, R>,
  file: string,
): Effect.Effect<CompileResult, CompilationError, R> =>
  operation.pipe(
    Effect.catchCause((cause): Effect.Effect<CompileResult, CompilationError> => {
      const reason = cause.reasons.length === 1 ? cause.reasons[0] : undefined;

      const error = reason?._tag === "Fail" ? reason.error : undefined;

      if (error instanceof AuthorError) {
        return Effect.succeed({
          ok: false,
          diagnostics: [
            { code: error.code, message: error.message, file: error.file, line: 1, column: 1 },
          ],
        });
      }

      if (error instanceof EvaluationError) {
        const value = error.diagnostic;

        return Effect.succeed({
          ok: false,
          diagnostics: [
            {
              code: value.code,
              message: value.message,
              file: value.source?.module ?? file,
              line: value.source?.line ?? 1,
              column: value.source?.column ?? 1,
            },
          ],
        });
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
