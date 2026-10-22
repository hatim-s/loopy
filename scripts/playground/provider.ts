import { sandboxConfigSchema } from "../../apps/sandbox/src/config.js";
import { DockerBackend } from "../../apps/sandbox/src/docker.js";
import { startSandbox } from "../../apps/sandbox/src/server.js";
import { config, dockerContext, image, runtime, sandboxState } from "./config.js";
import { boundedBackend } from "./runtime-limit.js";

const settings = await config();

const providerConfig = sandboxConfigSchema.parse({
  worktree: runtime,
  stateRoot: sandboxState,
  token: settings.sandboxToken,
  dockerContext,
  image,
  port: 15071,
});

const docker = new DockerBackend(providerConfig);

const backend = boundedBackend(docker, settings.runtimeConcurrency);

const service = await startSandbox(providerConfig, backend);

let closing = false;

async function stop() {
  if (!closing) {
    closing = true;
    await service.close();
  }
}

process.on("SIGTERM", () => void stop());

process.on("SIGINT", () => void stop());

console.log("Playground sandbox listening on 127.0.0.1:15071; Docker backend operation limit 4.");
