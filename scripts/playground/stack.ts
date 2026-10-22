import { spawn } from "node:child_process";
import { chmod, mkdir, open, unlink } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { z } from "zod";
import { PlaygroundClient } from "./client.js";
import {
  api,
  atomic,
  dashboard,
  dockerContext,
  image,
  initialize,
  root,
  runtime,
  sandboxState,
  state,
} from "./config.js";

const manifestPath = resolve(state, "processes.json");

const manifestSchema = z.object({
  owner: z.number(),
  root: z.literal(root),
  argv: z.array(z.string()),
  children: z.array(z.object({ name: z.string(), pid: z.number() })),
});

export async function start() {
  await initialize();

  if (await Bun.file(manifestPath).exists()) {
    throw new Error(
      "Playground process manifest exists. Run status; use the recorded stop command before restarting.",
    );
  }

  for (const port of [15070, 15071, 15072, 15073]) {
    await new Promise<void>((done, reject) => {
      const listener = createServer();
      listener.once("error", () => reject(new Error(`Playground port ${port} is occupied.`)));
      listener.listen(port, "127.0.0.1", () => listener.close(() => done()));
    });
  }

  const log = await open(resolve(state, "supervisor.log"), "a", 0o600);

  try {
    const child = spawn(
      process.execPath,
      ["--no-env-file", resolve(root, "scripts/playground/index.ts"), "serve"],
      {
        cwd: root,
        detached: true,
        stdio: ["ignore", log.fd, log.fd],
        env: cleanEnvironment(),
      },
    );

    child.unref();
    console.log(
      JSON.stringify({
        status: "starting",
        supervisor: child.pid,
        api,
        dashboard,
        stop: "bun --no-env-file scripts/playground/index.ts stop",
      }),
    );
  } finally {
    await log.close();
  }
}

function cleanEnvironment() {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    XDG_CONFIG_HOME: resolve(state, "tool-config"),
    WRANGLER_LOG_PATH: resolve(state, "wrangler.log"),
    WRANGLER_REGISTRY_PATH: resolve(state, "registry"),
    WRANGLER_SEND_METRICS: "false",
    BROWSER: "none",
  };
}

export async function serve() {
  const settings = await initialize();
  await mkdir(runtime, { recursive: true, mode: 0o700 });

  const inspection = Bun.spawn(
    ["docker", "--context", dockerContext, "image", "inspect", image, "--format", "{{.Id}}"],
    { stdout: "ignore", stderr: "ignore" },
  );

  if ((await inspection.exited) !== 0) {
    throw new Error("Required local Docker image is unavailable. No services started.");
  }

  const original: unknown = await Bun.file(resolve(root, "apps/cloud/wrangler.jsonc")).json();

  const wrangler = z
    .object({ vars: z.record(z.string(), z.string()) })
    .passthrough()
    .parse(original);

  await atomic(resolve(state, "wrangler.json"), {
    ...wrangler,
    name: "loopy-playground-local",
    main: resolve(root, "apps/cloud/src/worker.ts"),
    vars: { ...wrangler.vars, SANDBOX_URL: "http://127.0.0.1:15071", CONCURRENCY: "4" },
    dev: { ip: "127.0.0.1", port: 15070, inspector_port: 15073 },
  });
  const vars = resolve(state, "worker.dev.vars");
  await Bun.write(
    vars,
    `LOCAL_AUTH='${JSON.stringify([
      { workspace: "playground", token: settings.token },
      { workspace: "other", token: settings.otherToken },
    ])}'\nSANDBOX_TOKEN=${JSON.stringify(settings.sandboxToken)}\n`,
  );
  await chmod(vars, 0o600);
  await Bun.write(
    resolve(state, "dashboard.url"),
    `${dashboard}/#token=${encodeURIComponent(settings.token)}\n`,
  );
  await chmod(resolve(state, "dashboard.url"), 0o600);
  const children: { name: string; process: ReturnType<typeof Bun.spawn> }[] = [];

  function launch(name: string, command: string[], extra: Record<string, string> = {}) {
    children.push({
      name,
      process: Bun.spawn(command, {
        cwd: root,
        env: { ...cleanEnvironment(), ...extra },
        stdin: "ignore",
        stdout: Bun.file(resolve(state, `${name}.log`)),
        stderr: Bun.file(resolve(state, `${name}.error.log`)),
      }),
    });
  }

  launch("sandbox", [
    process.execPath,
    "--no-env-file",
    resolve(root, "scripts/playground/provider.ts"),
  ]);
  launch("worker", [
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
      "15072",
      "--strictPort",
    ],
    { LOOPY_API_ORIGIN: api },
  );
  let closing = false;

  const stopChildren = () => {
    if (!closing) {
      closing = true;

      for (const child of children) {
        child.process.kill("SIGTERM");
      }
    }
  };

  process.on("SIGTERM", stopChildren);
  process.on("SIGINT", stopChildren);
  await atomic(manifestPath, {
    owner: process.pid,
    root,
    argv: process.argv,
    api,
    dashboard,
    state,
    sandboxState,
    dockerContext,
    createdAt: new Date().toISOString(),
    stopCommand: "bun --no-env-file scripts/playground/index.ts stop",
    children: children.map((child) => ({ name: child.name, pid: child.process.pid })),
  });
  await Promise.race(children.map((child) => child.process.exited));
  stopChildren();
  await Promise.all(children.map((child) => child.process.exited));
  await unlink(manifestPath);
}

export async function stop() {
  const manifest = manifestSchema.parse(await Bun.file(manifestPath).json());

  const child = Bun.spawn(["ps", "-p", String(manifest.owner), "-o", "command="], {
    stdout: "pipe",
  });

  const command = await new Response(child.stdout).text();

  if (
    (await child.exited) !== 0 ||
    !command.includes(`${root}/scripts/playground/index.ts serve`)
  ) {
    throw new Error(
      "Supervisor identity does not match manifest. Refusing to signal another process.",
    );
  }

  process.kill(-manifest.owner, "SIGTERM");
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
