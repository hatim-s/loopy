import {
  type AttemptLog,
  type CommandSpec,
  DEFAULT_MAX_OUTPUT_BYTES,
  type ExecutionKey,
  type ExecutionResult,
  type ExecutionSpec,
  ExecutorError,
  errorMessage,
  type Json,
  limitLogs,
  renderCommand,
} from "@loopy/core";
import { Cause, Effect, Exit } from "effect";
import {
  CommandExecutionError,
  executeLocalCommand,
  type ScratchCleanupError,
  spawnCaptured,
  withBundleSandbox,
} from "../os";
import { type ExecutionOptions, type PreparedExecution, prepareExecution } from "./prepare";
import { bundleResult, commandResult, stoppedCode, stoppedResult } from "./protocol";
import { alreadyStarted, FilesystemReceipts } from "./receipts";

type Redact = PreparedExecution["redact"];

/** Interrupts, defects and aborts stay failures. Any other outcome survives a failed cleanup. */
function keepOutcome(error: ScratchCleanupError, redact: Redact, logs: AttemptLog[]) {
  const { primary } = error;

  if (
    Exit.isFailure(primary) &&
    (Cause.hasInterrupts(primary.cause) ||
      Cause.hasDies(primary.cause) ||
      primary.cause.reasons.some(
        (reason) =>
          Cause.isFailReason(reason) &&
          reason.error instanceof CommandExecutionError &&
          reason.error.reason === "aborted",
      ))
  ) {
    return Effect.failCause(Cause.combine(primary.cause, Cause.fail(error)));
  }

  logs.push({ message: "cleanup", data: redact(errorMessage(error.cause.cause)) });

  return primary;
}

/** Unstarted and aborted processes may retry. Every other stop is a durable failure. */
const isDurable = (cause: unknown): cause is CommandExecutionError =>
  cause instanceof CommandExecutionError &&
  cause.reason !== "unstarted" &&
  cause.reason !== "aborted";

// The executing host picks the platform variant, so argv renders here and not in the engine.
function renderedArgv(spec: CommandSpec) {
  try {
    return { kind: "ready" as const, argv: renderCommand(spec, process.platform) };
  } catch (cause) {
    return { kind: "rejected" as const, message: errorMessage(cause) };
  }
}

export class ExecutionWorker {
  private readonly receipts: FilesystemReceipts;

  constructor(private readonly options: ExecutionOptions) {
    this.receipts = new FilesystemReceipts(options.home);
  }

  execute = Effect.fn("ExecutionWorker.execute")(function* (
    this: ExecutionWorker,
    key: ExecutionKey,
    attempt: number,
    spec: ExecutionSpec,
    signal: AbortSignal,
  ) {
    const previous = yield* this.receipts.read({ executionKey: key, attempt });

    if (previous?.kind === "finished") {
      return previous.result;
    }

    if (previous?.kind === "started") {
      return yield* alreadyStarted();
    }

    const environment = yield* prepareExecution(this.options, spec);

    return yield* Effect.gen({ self: this }, function* () {
      const claim = yield* this.receipts.claim({ executionKey: key, attempt });

      if (claim.kind === "existing") {
        return claim.receipt.kind === "finished" ? claim.receipt.result : yield* alreadyStarted();
      }

      const result = yield* this.perform(spec, signal, environment);

      const receipt = yield* this.receipts.finish({
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

    const cleanupLogs: AttemptLog[] = [];

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
          { timeoutMs, maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES, signal },
        ),
    ).pipe(
      Effect.catchTag("ScratchCleanupError", (error) => keepOutcome(error, redact, cleanupLogs)),
      Effect.map((raw) => bundleResult(raw, redact)),
      Effect.catchIf(isDurable, (cause) =>
        Effect.succeed(
          bundleResult(cause.output, redact, {
            code: stoppedCode(cause.reason),
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

    const { env, redact, home } = environment;
    const rendered = renderedArgv(spec);

    if (rendered.kind === "rejected") {
      return {
        kind: "failed",
        error: { code: "execution", message: redact(rendered.message) },
        exitCode: null,
        logs: [],
      };
    }

    const [program, ...args] = rendered.argv;
    const cleanupLogs: AttemptLog[] = [];

    const step = yield* executeLocalCommand(
      {
        program,
        args,
        cwd: spec.cwd,
        env: spec.env,
        stdin: spec.stdin,
        timeoutMs: spec.timeoutMs,
        maxOutputBytes: spec.maxOutputBytes,
      },
      {
        workspace: this.options.workspace,
        mode: this.options.mode,
        protectedHome: home,
        sensitiveEnv: env,
        signal,
      },
    ).pipe(
      Effect.catchTag("ScratchCleanupError", (error) => keepOutcome(error, redact, cleanupLogs)),
      Effect.map((raw) => commandResult(spec, raw, redact)),
      Effect.catchIf(isDurable, (cause) =>
        Effect.succeed({ kind: "finished" as const, result: stoppedResult(cause, redact) }),
      ),
      Effect.mapError((cause) => new ExecutorError({ operation: "execute", cause })),
    );

    if (step.kind === "finished") {
      return { ...step.result, logs: [...step.result.logs, ...cleanupLogs] };
    }

    const parsed = yield* this.bundle(
      step.bundleHash,
      step.result,
      step.timeoutMs,
      signal,
      environment,
    );

    return { ...parsed, logs: [...step.logs, ...cleanupLogs, ...parsed.logs] };
  });
}
