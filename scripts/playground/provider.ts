import { DockerArtifacts } from "../../apps/sandbox/src/artifacts.js";
import type { AttemptDependenciesFactory } from "../../apps/sandbox/src/attempt-dependencies.js";
import { sandboxConfigSchema } from "../../apps/sandbox/src/config.js";
import { DockerBackend } from "../../apps/sandbox/src/docker.js";
import { filesystemDependencies } from "../../apps/sandbox/src/filesystem.js";
import { HttpSandboxAuthority } from "../../apps/sandbox/src/http-authority.js";
import { startSandbox } from "../../apps/sandbox/src/server.js";
import { config, dockerContext, image, profile, runtime, sandboxState } from "./config.js";
import { requireFreshDurableRoot } from "./receipt-selection.js";
import { boundedBackend } from "./runtime-limit.js";

const settings = await config();

const providerConfig = sandboxConfigSchema.parse({
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
    ? async () => {
        await requireFreshDurableRoot(providerConfig.stateRoot);

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
      }
    : filesystemDependencies(providerConfig, { backend });

const service = await startSandbox(providerConfig, dependencies);

let closing = false;

async function stop() {
  if (!closing) {
    closing = true;
    await service.close();
  }
}

process.on("SIGTERM", () => void stop());

process.on("SIGINT", () => void stop());

console.log(
  `Playground sandbox listening on ${profile.sandbox}; receipt mode ${profile.receiptMode}; Docker backend operation limit 4.`,
);
