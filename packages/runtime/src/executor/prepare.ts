import { realpath } from "node:fs/promises";
import { type ExecutionMode, type ExecutionSpec, ExecutorError, errorMessage } from "@loopy/core";
import { Effect, Result } from "effect";
import { renderCommand, SecretStore, secretRedactor } from "../local/execution-host";

export type ExecutionOptions = {
  home: string;
  workspace: string;
  mode: ExecutionMode;
  secrets: readonly string[];
  bundlePath: (hash: string) => string;
};

const pathOf = (path: string) =>
  Effect.tryPromise({
    try: () => realpath(path),
    catch: (cause) => new ExecutorError({ operation: "execute", cause }),
  });

export const specBundles = (spec: ExecutionSpec) =>
  spec.kind === "code" ? [spec.bundleHash] : spec.parse ? [spec.parse.bundleHash] : [];

/** Resolve inputs before claiming. Missing artifacts must not consume an execution attempt. */
export const prepareExecution = Effect.fn("ExecutionWorker.prepare")(function* (
  options: ExecutionOptions,
  spec: ExecutionSpec,
) {
  const env = yield* new SecretStore(options.home)
    .values(options.secrets)
    .pipe(Effect.mapError((cause) => new ExecutorError({ operation: "secret", cause })));

  const secrets = { env, redact: secretRedactor(Object.values(env)) };

  const home = yield* pathOf(options.home);
  const workspace = yield* pathOf(options.workspace);

  const rendered = yield* Effect.try({
    try: () => (spec.kind === "command" ? renderCommand(spec) : []),
    catch: errorMessage,
  }).pipe(Effect.result);

  const command = Result.isFailure(rendered)
    ? { kind: "rejected" as const, message: rendered.failure }
    : spec.kind === "command" && !rendered.success[0]
      ? { kind: "rejected" as const, message: "Command argv is empty." }
      : { kind: "ready" as const, argv: rendered.success };

  const hashes = specBundles(spec);

  const bundles: Record<string, string> = {};

  for (const hash of hashes) {
    const source = yield* Effect.try({
      try: () => options.bundlePath(hash),
      catch: (cause) => new ExecutorError({ operation: "execute", cause }),
    });

    bundles[hash] = yield* pathOf(source);
  }

  return { ...secrets, home, workspace, command, bundles };
});

export type PreparedExecution = Effect.Success<ReturnType<typeof prepareExecution>>;
