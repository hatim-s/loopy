import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  durationMs,
  type ExecutionKey,
  type ExecutionMode,
  type ExecutionSpec,
  type Executor,
  ExecutorError,
} from "@loopy/core";
import { Effect } from "effect";
import { spawnCaptured } from "../local/execution-host";
import { specBundles } from "./prepare";
import { FilesystemReceipts } from "./receipts";
import { workerFailure } from "./response";

type Options = {
  home: string;
  workspace: string;
  mode: ExecutionMode;
  secrets: readonly string[];
  bundlePath: (hash: string) => string;
  receipts?: FilesystemReceipts;
};

export class LocalExecutor implements Executor {
  private readonly receipts: FilesystemReceipts;

  constructor(private readonly options: Options) {
    this.receipts = options.receipts ?? new FilesystemReceipts(options.home);

    if (this.receipts.descriptor.home !== options.home) {
      throw new Error("Execution receipts must use the protected daemon home.");
    }
  }
  lookup = Effect.fn("LocalExecutor.lookup")(function* (
    this: LocalExecutor,
    key: ExecutionKey,
    attempt: number,
  ) {
    const receipt = yield* this.receipts.reconcile({ executionKey: key, attempt });

    return receipt.kind === "finished" ? receipt.receipt : receipt;
  });
  execute = Effect.fn("LocalExecutor.execute")(function* (
    this: LocalExecutor,
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

    const hashes = specBundles(spec);

    const bundles = yield* Effect.try({
      try: () => Object.fromEntries(hashes.map((hash) => [hash, this.options.bundlePath(hash)])),
      catch: (cause) => new ExecutorError({ operation: "execute", cause }),
    });

    const worker = fileURLToPath(
      new URL(import.meta.url.endsWith(".ts") ? "./worker.ts" : "./worker.js", import.meta.url),
    );

    const completed = yield* spawnCaptured(
      {
        program: process.execPath,
        args: ["--no-env-file", worker],
        cwd: dirname(worker),
        env: this.options.mode === "full" ? process.env : { PATH: process.env.PATH },
        stdin: JSON.stringify({
          options: {
            home: this.options.home,
            workspace: this.options.workspace,
            mode: this.options.mode,
            secrets: this.options.secrets,
            receipts: this.receipts.descriptor,
            bundles,
          },
          key,
          attempt,
          spec,
        }),
      },
      {
        timeoutMs:
          spec.kind === "code"
            ? spec.timeoutMs + 30_000
            : (spec.node.options.timeout === undefined
                ? 300_000
                : durationMs(spec.node.options.timeout)) +
              (spec.parse === null ? 0 : 300_000) +
              30_000,
        maxOutputBytes: 64 * 1024,
        // Let the worker escalate its own process group and persist its receipt first.
        killGraceMs: 10_000,
      },
      signal,
      performance.now(),
    ).pipe(
      Effect.map((output) => ({ kind: "output" as const, output })),
      Effect.catchTag("CommandExecutionError", (cause) =>
        Effect.succeed({ kind: "failure" as const, cause, output: cause.output }),
      ),
    );

    const observed = yield* this.receipts.read({ executionKey: key, attempt });

    if (observed?.kind === "finished") {
      return observed.result;
    }

    const failure = workerFailure(completed.output.stdout);
    const receipt = yield* this.receipts.reconcile({ executionKey: key, attempt });

    if (receipt.kind === "finished" && receipt.source === "stored") {
      return receipt.receipt.result;
    }

    // A trusted infrastructure report cannot reopen the reconciled attempt.
    if (failure !== undefined) {
      return yield* Effect.fail(
        new ExecutorError({ operation: failure.operation, cause: new Error(failure.message) }),
      );
    }

    // Sealing an unfinished receipt does not turn a failed worker transport into success.
    if (completed.kind === "failure") {
      return yield* Effect.fail(
        new ExecutorError({ operation: "execute", cause: completed.cause }),
      );
    }

    if (receipt.kind === "finished") {
      return receipt.receipt.result;
    }

    return yield* Effect.fail(
      new ExecutorError({
        operation: "execute",
        cause: new Error(
          `Executor exited without a completion receipt. ${completed.output.stderr.slice(-500)}`,
        ),
      }),
    );
  });
}
