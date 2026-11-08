import { decodeBoundary } from "@loopy/contract";
import { Effect } from "effect";
import { DockerArtifacts } from "../../../sandbox/src/artifacts";
import type { AttemptDependenciesFactory } from "../../../sandbox/src/attempt/dependencies";
import { sandboxConfig, sandboxConfigSchema } from "../../../sandbox/src/config";
import { DockerBackend } from "../../../sandbox/src/docker";
import { DockerClient } from "../../../sandbox/src/docker/client";
import { SANDBOX_DOCKER_CONTEXT } from "../../../sandbox/src/docker/identity";
import { filesystemStorage } from "../../../sandbox/src/filesystem";
import { io } from "../../../sandbox/src/operations";
import { startSandbox } from "../../../sandbox/src/server";
import { config, profile, runtime } from "./config";
import { CONCURRENCY } from "./plan";
import { receiptAuthority, requireFreshDurableRoot } from "./receipt/selection";
import { boundedBackend } from "./runtime-limit";

const settings = await config();

const providerConfig = sandboxConfig(
  decodeBoundary(sandboxConfigSchema)({
    worktree: runtime,
    token: settings.sandboxToken,
    dockerContext: SANDBOX_DOCKER_CONTEXT,
    image: profile.image,
    port: profile.sandboxPort,
  }),
);

const client = new DockerClient(providerConfig);

const backend = boundedBackend(new DockerBackend(providerConfig, client), CONCURRENCY);

function dependencies(): AttemptDependenciesFactory {
  if (settings.receiptMode === "filesystem") {
    return () =>
      Effect.sync(() => ({
        ...filesystemStorage(providerConfig.stateRoot),
        backend,
        artifactReader: new DockerArtifacts(providerConfig, client),
      }));
  }

  return () =>
    Effect.gen(function* () {
      yield* io("fresh durable root", () => requireFreshDurableRoot(providerConfig.stateRoot));
      const authority = receiptAuthority(settings);

      return {
        authority,
        resultsFor: (workspace) => authority.resultsFor(workspace),
        backend,
        artifactReader: new DockerArtifacts(providerConfig, client),
      };
    });
}

await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      yield* startSandbox(providerConfig, dependencies());
      console.log(
        `Playground sandbox listening on ${profile.sandbox}; receipt mode ${settings.receiptMode}; Docker backend operation limit ${CONCURRENCY}.`,
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
