import { mkdir, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { Schema } from "effect";
import { SANDBOX_DOCKER_CONTEXT } from "../../../sandbox/src/docker/identity";
import { root } from "../stack/constants";
import {
  type Child,
  dashboardArgv,
  launch,
  requireSandboxImage,
  wranglerArgv,
} from "../stack/launch";
import { waitUntilReady } from "../stack/readiness";
import { api, dashboard, initialize, profile, runtime, sandboxState, state } from "./config";
import { atomic } from "./files";
import {
  cleanEnvironment,
  manifestPath,
  requireFreeStackPorts,
  writeStackConfig,
} from "./stack-config";
import {
  observeProcess,
  parseServeIdentity,
  requireOwnedSupervisor,
  supervisorArguments,
} from "./stack-identity";

const healthSchema = Schema.Struct({
  service: Schema.Literal("loopy-cloud"),
  stage: Schema.Literal("local"),
});

const isHealthy = Schema.is(healthSchema);

async function workerHealthy() {
  const response = await fetch(`${api}/health`, { signal: AbortSignal.timeout(1000) });

  return response.ok && isHealthy(await response.json());
}

export async function serve(input: Parameters<typeof parseServeIdentity>[0]) {
  const selection = { root, state, profile: profile.label };
  const identity = parseServeIdentity(input, selection);
  const argv = [process.execPath, ...supervisorArguments(identity)];
  const ownership = { version: 2 as const, owner: process.pid, pgid: process.pid, identity, argv };
  requireOwnedSupervisor(ownership, await observeProcess(process.pid), selection);
  await requireFreeStackPorts();
  const settings = await initialize();
  await mkdir(runtime, { recursive: true, mode: 0o700 });
  await requireSandboxImage(profile.image, cleanEnvironment());
  const vars = await writeStackConfig(settings);
  const children: { name: string; process: Child }[] = [];

  const start = (name: string, command: string[], extra: Record<string, string> = {}) => {
    const child = launch({
      argv: command,
      env: { ...cleanEnvironment(), ...extra },
      logs: state,
      log: name,
    });

    children.push({ name, process: child });

    return child;
  };

  const startSandbox = () =>
    start("sandbox", [
      process.execPath,
      "--no-env-file",
      resolve(root, "apps/cloud/dev/playground/provider.ts"),
    ]);

  let closing = false;
  let registered = false;

  const stopChildren = () => {
    closing = true;

    for (const child of children) {
      child.process.kill("SIGTERM");
    }
  };

  process.on("SIGTERM", stopChildren);
  process.on("SIGINT", stopChildren);

  try {
    // The Durable Object authority lives in the Worker, so its sandbox starts only after health.
    if (settings.receiptMode === "filesystem") {
      startSandbox();
    }

    const worker = start(
      "worker",
      wranglerArgv({
        config: resolve(state, "wrangler.json"),
        persistTo: resolve(state, "wrangler"),
        envFile: vars,
      }),
    );

    if (settings.receiptMode === "durable-object") {
      await waitUntilReady({
        children: [worker],
        probes: [workerHealthy],
        timeoutMs: 15_000,
        intervalMs: 200,
        timeoutMessage:
          "Owned Worker health did not become ready within fifteen seconds. Sandbox was not started.",
      });

      if (closing) {
        return;
      }

      startSandbox();
    }

    start("dashboard", dashboardArgv(profile.dashboardPort), { LOOPY_API_ORIGIN: api });
    atomic(manifestPath, {
      ...ownership,
      root,
      api,
      dashboard,
      state,
      sandboxState,
      dockerContext: SANDBOX_DOCKER_CONTEXT,
      createdAt: new Date().toISOString(),
      stopCommand: profile.stopCommand,
      children: children.map((child) => ({ name: child.name, pid: child.process.pid })),
    });
    registered = true;
    await Promise.race(children.map((child) => child.process.exited));
  } finally {
    stopChildren();
    await Promise.all(children.map((child) => child.process.exited));

    if (registered) {
      await unlink(manifestPath);
    }

    process.off("SIGTERM", stopChildren);
    process.off("SIGINT", stopChildren);
  }
}
