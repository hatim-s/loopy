import { spawn } from "node:child_process";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { decodeBoundary, routes, routeUrl } from "@loopy/contract";
import { root } from "../stack/constants";
import { PlaygroundClient } from "./client";
import { api, dashboard, initialize, profile, state } from "./config";
import { cleanEnvironment, manifestPath, requireFreeStackPorts } from "./stack-config";
import {
  observeProcess,
  requireOwnedSupervisor,
  supervisorArguments,
  supervisorManifestSchema,
} from "./stack-identity";

const selection = { root, state, profile: profile.label };

export async function start() {
  await initialize();

  if (await Bun.file(manifestPath).exists()) {
    throw new Error(
      "Playground process manifest exists. Run status; use the recorded stop command before restarting.",
    );
  }

  await requireFreeStackPorts();

  const identity = { ...selection, nonce: crypto.randomUUID() };
  const log = await open(resolve(state, "supervisor.log"), "a", 0o600);

  try {
    const child = spawn(process.execPath, supervisorArguments(identity), {
      cwd: root,
      detached: true,
      stdio: ["ignore", log.fd, log.fd],
      env: cleanEnvironment(),
    });

    child.unref();
    console.log(
      JSON.stringify({
        status: "starting",
        supervisor: child.pid,
        api,
        dashboard,
        stop: profile.stopCommand,
      }),
    );
  } finally {
    await log.close();
  }
}

export async function stop() {
  const manifest = decodeBoundary(supervisorManifestSchema)(await Bun.file(manifestPath).json());
  requireOwnedSupervisor(manifest, await observeProcess(manifest.owner), selection);
  process.kill(-manifest.pgid, "SIGTERM");
  console.log(
    "Sent SIGTERM to the verified playground process group. Data and Docker volumes are retained.",
  );
}

export async function status() {
  const client = await PlaygroundClient.open();
  const response = await client.request(routeUrl(routes.runs, {}));
  await response.body?.cancel();
  const pages = await fetch(dashboard, { signal: AbortSignal.timeout(3000) });
  await pages.body?.cancel();
  console.log(
    JSON.stringify({
      api: response.status,
      dashboard: pages.status,
      manifest: manifestPath,
      config: resolve(state, "config.json"),
    }),
  );
}
