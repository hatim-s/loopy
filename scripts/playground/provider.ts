import { Effect } from "effect";
import { DockerArtifacts } from "../../apps/sandbox/src/artifacts";
import type { AttemptDependenciesFactory } from "../../apps/sandbox/src/attempt/dependencies";
import { sandboxConfigSchema } from "../../apps/sandbox/src/config";
import { DockerBackend } from "../../apps/sandbox/src/docker";
import { filesystemDependencies } from "../../apps/sandbox/src/filesystem";
import { HttpSandboxAuthority } from "../../apps/sandbox/src/http-authority";
import { io } from "../../apps/sandbox/src/operations";
import { startSandbox } from "../../apps/sandbox/src/server";
import { decodeBoundary } from "../../packages/loopy/src/contract";
import { config, dockerContext, image, profile, runtime, sandboxState } from "./config";
import { requireFreshDurableRoot } from "./receipt/selection";
import { boundedBackend } from "./runtime-limit";

const settings = await config();

const providerConfig = decodeBoundary(sandboxConfigSchema)({
  worktree: runtime,
  stateRoot: sandboxState,
  token: settings.sandboxToken,
  dockerContext,
  image,
  port: profile.sandboxPort,
});

const docker = new DockerBackend(providerConfig);

const backend = boundedBackend(docker, settings.runtimeConcurrency);

const dependencies: AttemptDependenciesFactory =
  settings.receiptMode === "durable-object"
    ? () =>
        Effect.gen(function* () {
          yield* io("fresh durable root", () => requireFreshDurableRoot(providerConfig.stateRoot));

          const authority = new HttpSandboxAuthority({
            url: profile.api,
            token: settings.receiptsToken,
            namespace: profile.batchPrefix,
          });

          return {
            authority,
            resultsFor: (workspace) => authority.resultsFor(workspace),
            backend,
            artifactReader: new DockerArtifacts(providerConfig),
          };
        })
    : filesystemDependencies(providerConfig, { backend });

// The script scope owns the server until a process shutdown signal arrives.
await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      yield* startSandbox(providerConfig, dependencies);
      console.log(
        `Playground sandbox listening on ${profile.sandbox}; receipt mode ${profile.receiptMode}; Docker backend operation limit 4.`,
      );
      yield* Effect.callback<void>((resume) => {
        const stop = () => resume(Effect.void);
        process.once("SIGTERM", stop);
        process.once("SIGINT", stop);

        return Effect.sync(() => {
          process.off("SIGTERM", stop);
          process.off("SIGINT", stop);
        });
      });
    }),
  ),
);
