export const RESULT_LINE_SEPARATOR = "\n";

export const CONSOLE_METHODS = [
  "log",
  "info",
  "debug",
  "warn",
  "error",
  "trace",
  "table",
  "dir",
] as const;

export function splitResultLine(stdout: string) {
  const text = stdout.trimEnd();
  const offset = text.lastIndexOf(RESULT_LINE_SEPARATOR);

  return {
    line: text.slice(offset + RESULT_LINE_SEPARATOR.length),
    prefix: stdout.slice(0, offset + RESULT_LINE_SEPARATOR.length),
  };
}
