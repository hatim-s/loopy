import { realpath } from "node:fs/promises";
import {
  CommandExecutionError,
  DEFAULT_EXECUTION_TIMEOUT_MS,
  type ExecutionKey,
  type ExecutionResult,
  type ExecutionSpec,
  errorMessage,
  type Json,
  limitLogs,
} from "../core/index.js";
import type { Options } from "./options.js";
import { executeLocalCommand } from "./process.js";
import { bundleResult } from "./protocol.js";
import { finishReceipt, receiptPath, startReceipt } from "./receipts.js";
import { secretRedactor } from "./redact.js";
import { withBundleSandbox } from "./sandbox/launch.js";
import { spawnCaptured } from "./spawn.js";

export class ExecutionWorker {
  private readonly env: Record<string, string>;
  private readonly redact: ReturnType<typeof secretRedactor>;
  constructor(private readonly options: Options) {
    this.env = options.secrets;
    this.redact = secretRedactor(Object.values(this.env));
  }
  async execute(
    key: ExecutionKey,
    attempt: number,
    spec: ExecutionSpec,
    signal: AbortSignal,
  ): Promise<ExecutionResult> {
    const path = await receiptPath(this.options.home, key, attempt);
    await startReceipt(path, key, attempt);
    let result: ExecutionResult;

    try {
      result = await this.perform(spec, signal);
    } catch (cause) {
      result = {
        kind: "failed",
        error: {
          code: cause instanceof CommandExecutionError ? cause.code : "execution",
          message: this.redact(errorMessage(cause)),
        },
        exitCode: null,
        logs: [],
      };
    }

    // Every path redacts its own values exactly once, so a secret inside the marker cannot nest.
    result = { ...result, logs: limitLogs(result.logs) };
    await finishReceipt(path, { kind: "finished", result, executionKey: key, attempt });

    return result;
  }
  private async bundle(hash: string, input: Json, timeoutMs: number, signal: AbortSignal) {
    const bundle = await realpath(this.options.bundlePath(hash));
    const workspace = await realpath(this.options.workspace);

    try {
      const raw = await withBundleSandbox(
        {
          bundle,
          workspace,
          network: this.options.mode === "full",
          home: await realpath(this.options.home),
        },
        ({ program, args }) =>
          spawnCaptured(
            {
              program,
              args,
              cwd: workspace,
              env: {
                PATH: process.env.PATH,
                LANG: "C.UTF-8",
                HOME: workspace,
                TMPDIR: workspace,
                ...this.env,
              },
              stdin: JSON.stringify(input),
            },
            { timeoutMs, maxOutputBytes: 2 * 1024 * 1024, signal },
          ),
      );

      return bundleResult(raw, this.redact);
    } catch (cause) {
      if (!(cause instanceof CommandExecutionError)) {
        throw cause;
      }

      return bundleResult(cause.output, this.redact, { code: cause.code, message: cause.message });
    }
  }
  private async perform(spec: ExecutionSpec, signal: AbortSignal): Promise<ExecutionResult> {
    if (spec.kind === "code") {
      return this.bundle(spec.bundleHash, spec.input, spec.timeoutMs, signal);
    }

    const [program, ...args] = spec.argv;

    if (!program) {
      throw new Error("Command argv is empty.");
    }

    let raw;

    try {
      raw = await executeLocalCommand(
        {
          program,
          args,
          cwd: spec.cwd ?? undefined,
          env: spec.env,
          stdin: spec.stdin ?? undefined,
        },
        {
          ...this.options,
          protectedHome: await realpath(this.options.home),
          sensitiveEnv: this.env,
          signal,
        },
      );
    } catch (cause) {
      if (!(cause instanceof CommandExecutionError)) {
        throw cause;
      }

      return {
        kind: "failed",
        error: { code: cause.code, message: this.redact(cause.message) },
        exitCode: null,
        logs: [
          { message: "stdout", data: this.redact(cause.output.stdout, true) },
          { message: "stderr", data: this.redact(cause.output.stderr, true) },
        ],
      };
    }

    const result = {
      stdout: raw.stdout,
      stderr: raw.stderr,
      exitCode: raw.exitCode,
    };

    const stdout = this.redact(raw.stdout);
    const stderr = this.redact(raw.stderr);

    const logs = [
      { message: "stdout", data: stdout },
      { message: "stderr", data: stderr },
    ];

    if (!spec.okExitCodes.includes(result.exitCode)) {
      return {
        kind: "failed",
        error: {
          code: "exit",
          message: stderr
            ? `Command exited with code ${result.exitCode}: ${stderr.slice(-500)}. Inspect stderr and correct the command.`
            : `Command exited with code ${result.exitCode}. Correct the command.`,
        },
        exitCode: result.exitCode,
        logs,
      };
    }

    if (spec.parse === null) {
      return {
        kind: "succeeded",
        output: { stdout, stderr, exitCode: result.exitCode },
        logs,
      };
    }

    const parsed = await this.bundle(
      spec.parse.bundleHash,
      { result, input: spec.parse.input },
      DEFAULT_EXECUTION_TIMEOUT_MS,
      signal,
    );

    return { ...parsed, logs: [...logs, ...parsed.logs] };
  }
}
