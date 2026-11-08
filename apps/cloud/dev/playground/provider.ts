import { decodeBoundary } from "@loopy/contract";
import { Effect } from "effect";
import { DockerArtifacts } from "../../../sandbox/src/artifacts";
import type { AttemptDependenciesFactory } from "../../../sandbox/src/attempt/dependencies";
import { sandboxConfigSchema } from "../../../sandbox/src/config";
import { DockerBackend } from "../../../sandbox/src/docker";
import { filesystemDependencies } from "../../../sandbox/src/filesystem";
import { io } from "../../../sandbox/src/operations";
import { startSandbox } from "../../../sandbox/src/server";
import { DOCKER_CONTEXT } from "../stack/constants";
import { config, profile, runtime, sandboxState } from "./config";
import { CONCURRENCY } from "./plan";
import { receiptAuthority, requireFreshDurableRoot } from "./receipt/selection";
import { boundedBackend } from "./runtime-limit";

const settings = await config();

const providerConfig = decodeBoundary(sandboxConfigSchema)({
  worktree: runtime,
  stateRoot: sandboxState,
  token: settings.sandboxToken,
  dockerContext: DOCKER_CONTEXT,
  image: profile.image,
  port: profile.sandboxPort,
});

const backend = boundedBackend(new DockerBackend(providerConfig), CONCURRENCY);

function dependencies(): AttemptDependenciesFactory {
  if (settings.receiptMode === "filesystem") {
    return filesystemDependencies(providerConfig, { backend });
  }

  return () =>
    Effect.gen(function* () {
      yield* io("fresh durable root", () => requireFreshDurableRoot(providerConfig.stateRoot));
      const authority = receiptAuthority(settings);

      return {
        authority,
        resultsFor: (workspace) => authority.resultsFor(workspace),
        backend,
        artifactReader: new DockerArtifacts(providerConfig),
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
