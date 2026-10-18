import type { CompilerDiagnosticCode } from "../core/index.js";
import type { CompilerDiagnostic } from "./types.js";

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
