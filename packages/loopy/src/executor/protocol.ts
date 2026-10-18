import { z } from "zod";
import { jsonSchema } from "../contract/index.js";
import { type AttemptLog, type CommandResult, type ExecutionResult } from "../core/index.js";

const logSchema = z.strictObject({ message: z.string(), data: jsonSchema });

export function bundleResult(
  raw: CommandResult,
  redact: (text: string) => string,
): ExecutionResult {
  const lines = raw.stdout.trimEnd().split("\n");
  const last = lines.pop() ?? "";
  const leading = raw.stdout.slice(0, raw.stdout.lastIndexOf(last));

  const logs: AttemptLog[] = raw.stderr
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return logSchema.parse(JSON.parse(line));
      } catch {
        return { message: "stderr", data: line };
      }
    });

  if (leading.length > 0) {
    logs.push({ message: "stdout", data: leading });
  }

  if (raw.exitCode !== 0) {
    return {
      kind: "failed",
      error: {
        code: "execution",
        message: `Bundle exited with code ${raw.exitCode}. ${redact(raw.stderr).slice(-500)}`,
      },
      exitCode: raw.exitCode,
      logs,
    };
  }

  try {
    return { kind: "succeeded", output: jsonSchema.parse(JSON.parse(last)), logs };
  } catch {
    return {
      kind: "failed",
      error: { code: "protocol", message: "Bundle stdout must end with one JSON result line." },
      exitCode: null,
      logs,
    };
  }
}
