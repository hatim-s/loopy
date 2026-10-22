import { parseArgs } from "node:util";
import { sandboxConfigSchema } from "./config.js";
import { startSandbox } from "./server.js";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    worktree: { type: "string" },
    "state-root": { type: "string" },
    "docker-context": { type: "string" },
    image: { type: "string", default: "loopy-sandbox:bun-1.4.0" },
    hostname: { type: "string", default: "127.0.0.1" },
    port: { type: "string", default: "4010" },
    "max-timeout-ms": { type: "string", default: "600000" },
    memory: { type: "string", default: "256m" },
    cpus: { type: "string", default: "1" },
    pids: { type: "string", default: "64" },
  },
});

const config = sandboxConfigSchema.parse({
  worktree: values.worktree,
  stateRoot: values["state-root"],
  dockerContext: values["docker-context"],
  image: values.image,
  hostname: values.hostname,
  port: Number(values.port),
  maxTimeoutMs: Number(values["max-timeout-ms"]),
  memory: values.memory,
  cpus: Number(values.cpus),
  pids: Number(values.pids),
  token: process.env.LOOPY_SANDBOX_TOKEN,
});

const service = await startSandbox(config);

process.stderr.write(`Sandbox listening at ${service.server.url}\n`);

let closing = false;

const stop = async () => {
  if (!closing) {
    closing = true;
    await service.close();
  }
};

process.on("SIGTERM", () => void stop());

process.on("SIGINT", () => void stop());
