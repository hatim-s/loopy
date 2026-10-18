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

type Redact = (text: string, truncated?: boolean) => string;

const logSchema = z.strictObject({ message: z.string(), data: jsonSchema });

function parseRecord(line: string): AttemptLog | undefined {
  try {
    return logSchema.parse(JSON.parse(line));
  } catch {
    return undefined;
  }
}

/**
 * Only whole log records are parsed. Everything else stays raw text, and consecutive raw lines
 * form one block so a secret spanning lines is still matched by the raw redactor.
 */
function stderrLogs(stderr: string, redact: Redact, cut: boolean): AttemptLog[] {
  const logs: AttemptLog[] = [];
  let block: string[] = [];

  const flush = (final: boolean) => {
    const text = block.join("\n");
    block = [];

    if (text.trim()) {
      logs.push({ message: "stderr", data: redact(text, cut && final) });
    }
  };

  for (const line of stderr.split("\n")) {
    const record = parseRecord(line);

    if (!record) {
      block.push(line);
      continue;
    }

    flush(false);
    logs.push({ message: redact(record.message), data: redactValue(record.data, redact) });
  }

  flush(true);

  return logs;
}

function parseOutput(line: string) {
  try {
    return jsonSchema.parse(JSON.parse(line));
  } catch {
    return undefined;
  }
}

export function bundleResult(
  raw: CommandResult,
  redact: Redact,
  failure?: Extract<ExecutionResult, { kind: "failed" }>["error"],
): ExecutionResult {
  // A killed process can stop mid-write, so the end of each stream may hold part of a secret.
  const cut = failure !== undefined;
  const failed = cut || raw.exitCode !== 0;
  const logs = stderrLogs(raw.stderr, redact, cut);
  const lastBreak = raw.stdout.trimEnd().lastIndexOf("\n");
  const output = parseOutput(raw.stdout.slice(lastBreak + 1));
  const stdout = output === undefined || failed ? raw.stdout : raw.stdout.slice(0, lastBreak + 1);

  if (stdout.trim()) {
    logs.push({ message: "stdout", data: redact(stdout, cut) });
  }

  const bounded = limitLogs(logs);

  if (failed) {
    const diagnostic = logs
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
