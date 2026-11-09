import { realpath } from "node:fs/promises";
import { type ExecutionSpec, ExecutorError, specBundles } from "@loopy/core";
import { Effect } from "effect";
import { SecretStore, secretRedactor } from "../os";
import type { WorkerOptions } from "./worker-protocol";

export type ExecutionOptions = WorkerOptions & { bundles: Readonly<Record<string, string>> };

const pathOf = (path: string) =>
  Effect.tryPromise({
    try: () => realpath(path),
    catch: (cause) => new ExecutorError({ operation: "execute", cause }),
  });

/** Resolve inputs before claiming. Missing artifacts must not consume an execution attempt. */
export const prepareExecution = Effect.fn("ExecutionWorker.prepare")(function* (
  options: ExecutionOptions,
  spec: ExecutionSpec,
) {
  const env = yield* new SecretStore(options.home)
    .values(options.secrets)
    .pipe(Effect.mapError((cause) => new ExecutorError({ operation: "secret", cause })));

  const home = yield* pathOf(options.home);
  const workspace = yield* pathOf(options.workspace);

  const bundles: Record<string, string> = {};

  for (const hash of specBundles(spec)) {
    const source = options.bundles[hash];

    if (source === undefined) {
      return yield* Effect.fail(
        new ExecutorError({
          operation: "execute",
          cause: new Error("Execution bundle was not supplied. Save the loopy again."),
        }),
      );
    }

    bundles[hash] = yield* pathOf(source);
  }

  return {
    env,
    redact: secretRedactor(Object.values(env)),
    home,
    workspace,
    bundles,
  };
});

export type PreparedExecution = Effect.Success<ReturnType<typeof prepareExecution>>;
