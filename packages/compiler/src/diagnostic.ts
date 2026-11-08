import type { ParseResult } from "oxc-parser";
import type { CompilerDiagnostic, CompilerDiagnosticCode } from "./types";

export function position(source: string, offset: number) {
  const lines = source.slice(0, offset).split("\n");

  return { line: lines.length, column: (lines.at(-1)?.length ?? 0) + 1 };
}

export function diagnostic(
  file: string,
  source: string,
  start: number,
  code: CompilerDiagnosticCode,
  message: string,
): CompilerDiagnostic {
  return { code, message, file, ...position(source, start) };
}

export function syntaxErrors(
  file: string,
  source: string,
  parsed: ParseResult,
  diagnostics: CompilerDiagnostic[],
) {
  for (const error of parsed.errors) {
    diagnostics.push(
      diagnostic(file, source, error.labels[0]?.start ?? 0, "syntax_error", error.message),
    );
  }
}
