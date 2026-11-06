import type { CompilerDiagnosticCode } from "@loopy/core";
import type { CompilerDiagnostic } from "./types";

export function diagnostic(
  file: string,
  source: string,
  start: number,
  code: CompilerDiagnosticCode,
  message: string,
): CompilerDiagnostic {
  const lines = source.slice(0, start).split("\n");

  return { code, message, file, line: lines.length, column: (lines.at(-1)?.length ?? 0) + 1 };
}
