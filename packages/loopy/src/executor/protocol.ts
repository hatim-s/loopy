import { z } from "zod";
import { jsonSchema } from "../contract/index.js";
import {
  type AttemptLog,
  type CommandResult,
  type ExecutionResult,
  isString,
  limitLogs,
} from "../core/index.js";
import { redactValue } from "./redact.js";

const logSchema = z.strictObject({ message: z.string(), data: jsonSchema });

function decodeFragment(text: string): string {
  // A killed writer can leave an unfinished record. Decode its string tokens before masking secrets.
  return text.replace(/"(?:\\.|[^"\\])*(?:"|\\?$)/gu, (token) => {
    try {
      return JSON.parse(token);
    } catch {
      return token
        .slice(1)
        .replace(/\\(?:u[\da-f]{4}|["\\/bfnrt])|\\(?:u[\da-f]{0,3})?$/giu, (escape) => {
          try {
            return JSON.parse(`"${escape}"`);
          } catch {
            return "";
          }
        });
    }
  });
}

export function bundleResult(
  raw: CommandResult,
  redact: (text: string, truncated?: boolean) => string,
  failure?: Extract<ExecutionResult, { kind: "failed" }>["error"],
): ExecutionResult {
  const lines = raw.stdout.trimEnd().split("\n");
  const last = lines.pop() ?? "";

  const logs: AttemptLog[] = raw.stderr
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return logSchema.parse(JSON.parse(line));
      } catch {
        return { message: "stderr", data: decodeFragment(line) };
      }
    });

  let output;

  try {
    output = jsonSchema.parse(JSON.parse(last));
  } catch {
    lines.push(last);
  }

  if (output !== undefined && (failure || raw.exitCode !== 0)) {
    lines.push(last);
  }

  if (lines.some(Boolean)) {
    logs.push({
      message: "stdout",
      data: lines.map(decodeFragment).join("\n") + (raw.stdout.endsWith("\n") ? "\n" : ""),
    });
  }

  const masked = logs.map((log) => ({
    message: redact(log.message, true),
    data: redactValue(log.data, (text) => redact(text, true)),
  }));

  const bounded = limitLogs(masked);

  if (failure || raw.exitCode !== 0) {
    const diagnostic = masked
      .map((log) => `${log.message}: ${isString(log.data) ? log.data : JSON.stringify(log.data)}`)
      .join("\n")
      .slice(-500);

    return {
      kind: "failed",
      error: {
        code: failure?.code ?? "execution",
        message: `${failure ? redact(failure.message) : `Bundle exited with code ${raw.exitCode}.`} ${diagnostic}`,
      },
      exitCode: failure ? null : raw.exitCode,
      logs: bounded,
    };
  }

  return output === undefined
    ? {
        kind: "failed",
        error: { code: "protocol", message: "Bundle stdout must end with one JSON result line." },
        exitCode: null,
        logs: bounded,
      }
    : { kind: "succeeded", output: redactValue(output, redact), logs: bounded };
}
