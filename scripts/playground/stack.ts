import { spawn } from "node:child_process";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { PlaygroundClient } from "./client.js";
import { api, dashboard, initialize, profile, root, state } from "./config.js";
import { cleanEnvironment, manifestPath, requireFreePorts } from "./stack-config.js";

import {
  requireOwnedSupervisor,
  type StackSelection,
  type SupervisorProcesses,
  supervisorArguments,
  supervisorManifestSchema,
  supervisorProcesses,
} from "./stack-identity.js";

export { serve } from "./supervisor.js";

const selection: StackSelection = { root, state, profile: profile.name ?? "default" };

export async function start() {
  await initialize();

  if (await Bun.file(manifestPath).exists()) {
    throw new Error(
      "Playground process manifest exists. Run status; use the recorded stop command before restarting.",
    );
  }

  await requireFreePorts();

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
        stop: `${profile.name ? "LOOPY_PLAYGROUND_PROFILE=architecture " : ""}bun --no-env-file scripts/playground/index.ts stop`,
      }),
    );
  } finally {
    await log.close();
  }
}

export async function stop(
  control: { selection: StackSelection; manifestPath: string; processes: SupervisorProcesses } = {
    selection,
    manifestPath,
    processes: supervisorProcesses,
  },
) {
  const manifest = supervisorManifestSchema.parse(await Bun.file(control.manifestPath).json());
  const observation = await control.processes.observe(manifest.owner);
  requireOwnedSupervisor(manifest, observation, control.selection);
  control.processes.signalGroup(manifest.pgid);
  console.log(
    "Sent SIGTERM to the verified playground process group. Data and Docker volumes are retained.",
  );
}

export async function status() {
  const client = await PlaygroundClient.open();
  const response = await client.request("/runs");
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
