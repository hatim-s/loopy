import { attemptLogSchema, jsonSchema } from "../contract/index.js";
import {
  type AttemptLog,
  type CommandResult,
  type ExecutionError,
  type ExecutionResult,
  isString,
  limitLogs,
  splitResultLine,
} from "../core/index.js";
import { type Redactor, redactValue } from "./redact.js";

function parseRecord(line: string): AttemptLog | undefined {
  try {
    return attemptLogSchema.parse(JSON.parse(line));
  } catch {
    return undefined;
  }
}

/** Consecutive raw lines stay together so secrets spanning lines still match. */
function stderrLogs(
  stderr: string,
  redact: Redactor,
  tail: (text: string) => string,
): AttemptLog[] {
  const logs: AttemptLog[] = [];
  let block: string[] = [];

  const flush = (mask: (text: string) => string) => {
    const text = block.join("\n");
    block = [];

    if (text.trim()) {
      logs.push({ message: "stderr", data: mask(text) });
    }
  };

  for (const line of stderr.split("\n")) {
    const record = parseRecord(line);

    if (!record) {
      block.push(line);
      continue;
    }

    flush(redact.complete);
    logs.push({
      message: redact.complete(record.message),
      data: redactValue(record.data, redact.complete),
    });
  }

  flush(tail);

  return logs;
}

function bundleLogs(
  raw: CommandResult,
  redact: Redactor,
  options: { stdout: string; tail: (text: string) => string },
) {
  const logs = stderrLogs(raw.stderr, redact, options.tail);

  if (options.stdout.trim()) {
    logs.push({ message: "stdout", data: options.tail(options.stdout) });
  }

  return logs;
}

function parseOutput(line: string) {
  try {
    return jsonSchema.parse(JSON.parse(line));
  } catch {
    return undefined;
  }
}

function failed(
  redact: Redactor,
  options: { error: ExecutionError; logs: AttemptLog[]; exitCode: number | null },
): ExecutionResult {
  const diagnostic = options.logs
    .map((log) => `${log.message}: ${isString(log.data) ? log.data : JSON.stringify(log.data)}`)
    .join("\n")
    .slice(-500);

  return {
    kind: "failed",
    error: {
      code: options.error.code,
      message: `${redact.complete(options.error.message)} ${diagnostic}`,
    },
    exitCode: options.exitCode,
    logs: limitLogs(options.logs),
  };
}

export function bundleSucceeded(raw: CommandResult, redact: Redactor): ExecutionResult {
  const { line, prefix } = splitResultLine(raw.stdout);
  const output = parseOutput(line);

  const logs = bundleLogs(raw, redact, {
    stdout: raw.exitCode !== 0 || output === undefined ? raw.stdout : prefix,
    tail: redact.complete,
  });

  if (raw.exitCode !== 0) {
    return failed(redact, {
      error: { code: "execution", message: `Bundle exited with code ${raw.exitCode}.` },
      logs,
      exitCode: raw.exitCode,
    });
  }

  return output === undefined
    ? {
        kind: "failed",
        error: { code: "protocol", message: "Bundle stdout must end with one JSON result line." },
        exitCode: null,
        logs: limitLogs(logs),
      }
    : { kind: "succeeded", output: redactValue(output, redact.complete), logs: limitLogs(logs) };
}

export function bundleStopped(
  raw: CommandResult,
  redact: Redactor,
  error: ExecutionError,
): ExecutionResult {
  // Stopped streams can end partway through an encoded secret.
  const logs = bundleLogs(raw, redact, { stdout: raw.stdout, tail: redact.fragment });

  return failed(redact, { error, logs, exitCode: null });
}
