import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  attemptBudgetMs,
  type ExecutionKey,
  type ExecutionSpec,
  type Executor,
  ExecutorError,
  specBundles,
} from "@loopy/core";
import { Effect } from "effect";
import { spawnCaptured } from "../os";
import { FilesystemReceipts } from "./receipts";
import { type WorkerOptions, type WorkerRequest, workerFailure } from "./worker-protocol";

type Options = WorkerOptions & { bundlePath: (hash: string) => string };

const WORKER = fileURLToPath(
  new URL(import.meta.url.endsWith(".ts") ? "./worker.ts" : "./worker.js", import.meta.url),
);

export class LocalExecutor implements Executor {
  private readonly receipts: FilesystemReceipts;

  constructor(private readonly options: Options) {
    this.receipts = new FilesystemReceipts(options.home);
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
    const identity = { executionKey: key, attempt };
    const previous = yield* this.lookup(key, attempt);

    if (previous.kind === "finished") {
      return previous.result;
    }

    if (previous.kind === "started") {
      return (yield* this.receipts.settle(identity)).result;
    }

    const bundles = yield* Effect.try({
      try: () =>
        Object.fromEntries(specBundles(spec).map((hash) => [hash, this.options.bundlePath(hash)])),
      catch: (cause) => new ExecutorError({ operation: "execute", cause }),
    });

    const { home, workspace, mode, secrets } = this.options;

    const request: WorkerRequest = {
      options: { home, workspace, mode, secrets, bundles },
      key,
      attempt,
      spec,
    };

    const completed = yield* spawnCaptured(
      {
        program: process.execPath,
        args: ["--no-env-file", WORKER],
        cwd: dirname(WORKER),
        env: mode === "full" ? process.env : { PATH: process.env.PATH },
        stdin: JSON.stringify(request),
      },
      {
        timeoutMs: attemptBudgetMs(spec),
        maxOutputBytes: 64 * 1024,
        // Let the worker escalate its own process group and persist its receipt first.
        killGraceMs: 10_000,
        signal,
      },
    ).pipe(
      Effect.map((output) => ({ kind: "output" as const, output })),
      Effect.catchTag("CommandExecutionError", (cause) =>
        Effect.succeed({ kind: "failure" as const, cause, output: cause.output }),
      ),
    );

    const observed = yield* this.receipts.read(identity);

    if (observed?.kind === "finished") {
      return observed.result;
    }

    const failure = workerFailure(completed.output.stdout);
    const receipt = yield* this.receipts.reconcile(identity);

    if (receipt.kind === "finished" && receipt.source === "stored") {
      return receipt.receipt.result;
    }

    // A trusted infrastructure report cannot reopen the reconciled attempt.
    if (failure !== undefined) {
      return yield* Effect.fail(
        new ExecutorError({ operation: failure.operation, cause: new Error(failure.message) }),
      );
    }

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
