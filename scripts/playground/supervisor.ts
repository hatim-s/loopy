import { mkdir, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import {
  api,
  atomic,
  dashboard,
  dockerContext,
  image,
  initialize,
  profile,
  root,
  runtime,
  sandboxState,
  state,
} from "./config.js";
import { waitForWorker } from "./readiness.js";
import {
  cleanEnvironment,
  manifestPath,
  requireFreePorts,
  writeStackConfig,
} from "./stack-config.js";
import {
  parseServeIdentity,
  requireOwnedSupervisor,
  supervisorArguments,
  supervisorProcesses,
} from "./stack-identity.js";

export async function serve(input: Parameters<typeof parseServeIdentity>[0]) {
  const selection = { root, state, profile: profile.name ?? "default" } as const;
  const identity = parseServeIdentity(input, selection);
  const argv = [process.execPath, ...supervisorArguments(identity)];
  const owner = await supervisorProcesses.observe(process.pid);
  const ownership = { version: 2 as const, owner: process.pid, pgid: process.pid, identity, argv };
  requireOwnedSupervisor(ownership, owner, selection);
  await requireFreePorts();
  const settings = await initialize();
  await mkdir(runtime, { recursive: true, mode: 0o700 });

  const inspection = Bun.spawn(
    ["docker", "--context", dockerContext, "image", "inspect", image, "--format", "{{.Id}}"],
    { stdout: "ignore", stderr: "ignore" },
  );

  if ((await inspection.exited) !== 0) {
    throw new Error("Required local Docker image is unavailable. No services started.");
  }

  const vars = await writeStackConfig(settings);
  const children: { name: string; process: ReturnType<typeof Bun.spawn> }[] = [];

  function launch(name: string, command: string[], extra: Record<string, string> = {}) {
    const child = Bun.spawn(command, {
      cwd: root,
      env: { ...cleanEnvironment(), ...extra },
      stdin: "ignore",
      stdout: Bun.file(resolve(state, `${name}.log`)),
      stderr: Bun.file(resolve(state, `${name}.error.log`)),
    });

    children.push({ name, process: child });

    return child;
  }

  const launchSandbox = () => {
    launch("sandbox", [
      process.execPath,
      "--no-env-file",
      resolve(root, "scripts/playground/provider.ts"),
    ]);
  };

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
    if (!profile.name) {
      launchSandbox();
    }

    const worker = launch("worker", [
      process.execPath,
      "x",
      "--no-install",
      "wrangler",
      "dev",
      "--local",
      "--config",
      resolve(state, "wrangler.json"),
      "--persist-to",
      resolve(state, "wrangler"),
      "--env-file",
      vars,
    ]);

    if (profile.name) {
      await waitForWorker(api, worker);

      if (closing) {
        return;
      }

      launchSandbox();
    }

    launch(
      "dashboard",
      [
        process.execPath,
        "run",
        "--cwd",
        "apps/dashboard",
        "dev",
        "--host",
        "127.0.0.1",
        "--port",
        String(profile.dashboardPort),
        "--strictPort",
      ],
      { LOOPY_API_ORIGIN: api },
    );
    await atomic(manifestPath, {
      ...ownership,
      root,
      api,
      dashboard,
      state,
      sandboxState,
      dockerContext,
      createdAt: new Date().toISOString(),
      stopCommand: `${profile.name ? "LOOPY_PLAYGROUND_PROFILE=architecture " : ""}bun --no-env-file scripts/playground/index.ts stop`,
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
