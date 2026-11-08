import { decodeJson, jsonSchema } from "@loopy/contract";
import {
  type AttemptLog,
  attemptLogSchema,
  type CommandResult,
  type CommandSpec,
  type ExecutionResult,
  isString,
  limitLogs,
  type ParserInput,
} from "@loopy/core";
import type { CommandExecutionError } from "../os";
import { redactValue } from "./redact";

type Redact = (text: string, truncated?: boolean) => string;

type FailureCode = Extract<ExecutionResult, { kind: "failed" }>["error"]["code"];

/**
 * Source of the entry the compiler bundles around each code or parser module. It writes the
 * protocol this file decodes: stderr lines are `{message, data}` logs, the final stdout line
 * is the JSON result, and a parser bundle reads the command result commandResult hands it.
 * Bun folds import.meta.main for virtual entrypoints, so the bundle compares its path.
 */
export function runnerSource(module: string, exportName: string, kind: "code" | "parser") {
  const invocation =
    kind === "code" ? "run(input, { workspace: process.cwd(), log })" : "run(input)";

  return `
    import {fileURLToPath} from "node:url";
    const main = process.argv[1] === fileURLToPath(import.meta.url);
    const log = (message, data = null) => process.stderr.write(JSON.stringify({message, data}) + "\\n");
    if (main) {
      for (const method of ["log", "info", "debug", "warn", "error", "trace", "table", "dir"]) {
        console[method] = (...values) => log(values.map(String).join(" "));
      }
    }
    const {${exportName}: run} = await import(${JSON.stringify(module)});
    export default run;
    if (main) {
      const input = await Bun.stdin.json();
      const output = await ${invocation};
      process.stdout.write("\\n" + JSON.stringify(output ?? null) + "\\n");
    }
  `;
}

/** The next step after a command exits: a final result, or its parser bundle with the raw result. */
export type CommandStep =
  | { kind: "finished"; result: ExecutionResult }
  | {
      kind: "parse";
      bundleHash: string;
      timeoutMs: number;
      result: ParserInput;
      logs: AttemptLog[];
    };

function exitMessage(exitCode: number, stderr: string) {
  return stderr
    ? `Command exited with code ${exitCode}: ${stderr.slice(-500)}. Inspect stderr and correct the command.`
    : `Command exited with code ${exitCode}. Correct the command.`;
}

/** Both the local executor and the sandbox worker interpret a command exit here. */
export function commandResult(spec: CommandSpec, raw: CommandResult, redact: Redact): CommandStep {
  const stdout = redact(raw.stdout);
  const stderr = redact(raw.stderr);

  const logs = [
    { message: "stdout", data: stdout },
    { message: "stderr", data: stderr },
  ];

  if (!spec.okExitCodes.includes(raw.exitCode)) {
    return {
      kind: "finished",
      result: {
        kind: "failed",
        error: { code: "exit", message: exitMessage(raw.exitCode, stderr) },
        exitCode: raw.exitCode,
        logs,
      },
    };
  }

  if (spec.parse === null) {
    return {
      kind: "finished",
      result: { kind: "succeeded", output: { stdout, stderr, exitCode: raw.exitCode }, logs },
    };
  }

  // Parsers read the unredacted streams inside the same sandbox; their output is redacted later.
  return {
    kind: "parse",
    bundleHash: spec.parse.bundleHash,
    timeoutMs: spec.parse.timeoutMs,
    result: { stdout: raw.stdout, stderr: raw.stderr, exitCode: raw.exitCode },
    logs,
  };
}

export function stoppedCode(reason: CommandExecutionError["reason"]): FailureCode {
  return reason === "output_limit" ? "output_limit" : "execution";
}

/** A killed process can stop mid-write, so both streams redact a trailing secret prefix. */
export function stoppedResult(
  stopped: Pick<CommandExecutionError, "reason" | "message" | "output">,
  redact: Redact,
): ExecutionResult {
  return {
    kind: "failed",
    error: { code: stoppedCode(stopped.reason), message: redact(stopped.message) },
    exitCode: null,
    logs: [
      { message: "stdout", data: redact(stopped.output.stdout, true) },
      { message: "stderr", data: redact(stopped.output.stderr, true) },
    ],
  };
}

function parseRecord(line: string): AttemptLog | undefined {
  try {
    return decodeJson(attemptLogSchema)(line);
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
    return decodeJson(jsonSchema)(line);
  } catch {
    return undefined;
  }
}

export function bundleResult(
  raw: CommandResult,
  redact: Redact,
  failure?: { code: FailureCode; message: string },
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
