import {
  CommandExecutionError,
  durationMs,
  type ExecutionKey,
  type ExecutionResult,
  type ExecutionSpec,
  type Executor,
  ExecutorError,
  errorMessage,
  type Json,
  limitLogs,
} from "@loopy/core";
import { Cause, Effect, Exit } from "effect";
import { executeLocalCommand, spawnCaptured, withBundleSandbox } from "../local/execution-host";
import { type ExecutionOptions, type PreparedExecution, prepareExecution } from "./prepare";
import { bundleResult } from "./protocol";
import type { FilesystemReceipts } from "./receipts";

type Options = ExecutionOptions & { receipts: FilesystemReceipts };

export class ExecutionWorker implements Executor {
  constructor(private readonly options: Options) {}
  lookup = Effect.fn("ExecutionWorker.lookup")(function* (
    this: ExecutionWorker,
    key: ExecutionKey,
    attempt: number,
  ) {
    return (
      (yield* this.options.receipts.read({ executionKey: key, attempt })) ?? {
        kind: "none" as const,
      }
    );
  });
  execute = Effect.fn("ExecutionWorker.execute")(function* (
    this: ExecutionWorker,
    key: ExecutionKey,
    attempt: number,
    spec: ExecutionSpec,
    signal: AbortSignal,
  ) {
    const previous = yield* this.lookup(key, attempt);

    if (previous.kind === "finished") {
      return previous.result;
    }

    if (previous.kind === "started") {
      return yield* Effect.fail(
        new ExecutorError({
          operation: "execute",
          cause: new Error("Execution already started. Reconcile its receipt."),
        }),
      );
    }

    const environment = yield* prepareExecution(this.options, spec);

    return yield* Effect.gen({ self: this }, function* () {
      const claim = yield* this.options.receipts.claim({ executionKey: key, attempt });

      if (claim.kind === "existing") {
        if (claim.receipt.kind === "finished") {
          return claim.receipt.result;
        }

        return yield* Effect.fail(
          new ExecutorError({
            operation: "execute",
            cause: new Error("Execution already started. Reconcile its receipt."),
          }),
        );
      }

      const result = yield* this.perform(spec, signal, environment);

      const receipt = yield* this.options.receipts.finish({
        kind: "finished",
        result: { ...result, logs: limitLogs(result.logs) },
        executionKey: key,
        attempt,
      });

      return receipt.result;
    }).pipe(
      Effect.mapError(
        (error) =>
          new ExecutorError({
            operation: error.operation,
            cause: error.cause,
            diagnostic: environment.redact(errorMessage(error.cause)),
          }),
      ),
    );
  });
  private bundle = Effect.fn("ExecutionWorker.bundle")(function* (
    this: ExecutionWorker,
    hash: string,
    input: Json,
    timeoutMs: number,
    signal: AbortSignal,
    { env, redact, home, workspace, bundles }: PreparedExecution,
  ) {
    const bundle = bundles[hash];

    if (bundle === undefined) {
      return yield* Effect.die(new Error("Prepared bundle is missing."));
    }

    const cleanupLogs: { message: string; data: Json }[] = [];

    return yield* withBundleSandbox(
      { bundle, workspace, network: this.options.mode === "full", home },
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
              ...env,
            },
            stdin: JSON.stringify(input),
          },
          { timeoutMs, maxOutputBytes: 2 * 1024 * 1024 },
          signal,
          performance.now(),
        ),
    ).pipe(
      Effect.catchTag("BundleCleanupError", (error) => {
        if (
          Exit.isFailure(error.primary) &&
          (Cause.hasInterrupts(error.primary.cause) ||
            Cause.hasDies(error.primary.cause) ||
            error.primary.cause.reasons.some(
              (reason) =>
                Cause.isFailReason(reason) &&
                reason.error instanceof CommandExecutionError &&
                reason.error.reason === "aborted",
            ))
        ) {
          return Effect.failCause(Cause.combine(error.primary.cause, Cause.fail(error)));
        }

        cleanupLogs.push({ message: "cleanup", data: redact(errorMessage(error.cause.cause)) });

        return error.primary;
      }),
      Effect.map((raw) => bundleResult(raw, redact)),
      Effect.catchIf(
        (cause): cause is CommandExecutionError =>
          cause instanceof CommandExecutionError &&
          cause.reason !== "unstarted" &&
          cause.reason !== "aborted",
        (cause) =>
          Effect.succeed(
            bundleResult(cause.output, redact, {
              code: cause.reason === "output_limit" ? "output_limit" : "execution",
              message: cause.message,
            }),
          ),
      ),
      Effect.map((result) => ({ ...result, logs: [...result.logs, ...cleanupLogs] })),
      Effect.mapError((cause) => new ExecutorError({ operation: "execute", cause })),
    );
  });
  private perform = Effect.fn("ExecutionWorker.perform")(function* (
    this: ExecutionWorker,
    spec: ExecutionSpec,
    signal: AbortSignal,
    environment: PreparedExecution,
  ): Effect.fn.Return<ExecutionResult, ExecutorError> {
    if (spec.kind === "code") {
      return yield* this.bundle(spec.bundleHash, spec.input, spec.timeoutMs, signal, environment);
    }

    const { env, redact } = environment;

    if (environment.command.kind === "rejected") {
      return {
        kind: "failed",
        error: { code: "execution", message: redact(environment.command.message) },
        exitCode: null,
        logs: [],
      };
    }

    const [program, ...args] = environment.command.argv;

    if (program === undefined) {
      return yield* Effect.die(new Error("Prepared command is missing."));
    }

    const home = environment.home;
    const cleanupLogs: { message: string; data: Json }[] = [];

    const attempt = yield* executeLocalCommand(
      {
        program,
        args,
        cwd: spec.cwd ?? undefined,
        env: spec.env,
        stdin: spec.stdin ?? undefined,
        maxOutputBytes: spec.node.options.maxOutputBytes,
        timeoutMs:
          spec.node.options.timeout === undefined
            ? undefined
            : durationMs(spec.node.options.timeout),
      },
      { ...this.options, protectedHome: home, sensitiveEnv: env, signal },
    ).pipe(
      Effect.catchTag("ProcessCleanupError", (error) => {
        if (
          Exit.isFailure(error.primary) &&
          (Cause.hasInterrupts(error.primary.cause) ||
            Cause.hasDies(error.primary.cause) ||
            error.primary.cause.reasons.some(
              (reason) =>
                Cause.isFailReason(reason) &&
                reason.error instanceof CommandExecutionError &&
                reason.error.reason === "aborted",
            ))
        ) {
          return Effect.failCause(Cause.combine(error.primary.cause, Cause.fail(error)));
        }

        cleanupLogs.push({ message: "cleanup", data: redact(errorMessage(error.cause.cause)) });

        return error.primary;
      }),
      Effect.map((raw) => ({ kind: "output" as const, raw })),
      Effect.catchIf(
        (cause): cause is CommandExecutionError =>
          cause instanceof CommandExecutionError &&
          cause.reason !== "unstarted" &&
          cause.reason !== "aborted",
        (cause) => Effect.succeed({ kind: "failure" as const, cause }),
      ),
      Effect.mapError((cause) => new ExecutorError({ operation: "execute", cause })),
    );

    if (attempt.kind === "failure") {
      const { cause } = attempt;

      return {
        kind: "failed",
        error: {
          code: cause.reason === "output_limit" ? "output_limit" : "execution",
          message: redact(errorMessage(cause)),
        },
        exitCode: null,
        logs: [
          { message: "stdout", data: redact(cause.output.stdout, true) },
          { message: "stderr", data: redact(cause.output.stderr, true) },
          ...cleanupLogs,
        ],
      };
    }

    const { raw } = attempt;
    const result = { stdout: raw.stdout, stderr: raw.stderr, exitCode: raw.exitCode };

    const stdout = redact(raw.stdout),
      stderr = redact(raw.stderr);

    const logs = [
      { message: "stdout", data: stdout },
      { message: "stderr", data: stderr },
      ...cleanupLogs,
    ];

    if (!spec.node.okExitCodes.includes(result.exitCode)) {
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
      return { kind: "succeeded", output: { stdout, stderr, exitCode: result.exitCode }, logs };
    }

    const parsed = yield* this.bundle(
      spec.parse.bundleHash,
      { result, input: spec.parse.input },
      300_000,
      signal,
      environment,
    );

    return { ...parsed, logs: [...logs, ...parsed.logs] };
  });
}
