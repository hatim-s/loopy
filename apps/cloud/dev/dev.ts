import { chmod, mkdir } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { z } from "zod";

const root = resolve(import.meta.dir, "../../..");

const state = resolve(root, ".loopy/cloud");

const configSchema = z.object({
  principals: z.array(z.object({ workspace: z.string(), token: z.string().min(32) })),
  sandboxToken: z.string().min(32),
});

await mkdir(state, { recursive: true, mode: 0o700 });

const configPath = resolve(state, "local.json");

if (!(await Bun.file(configPath).exists())) {
  await Bun.write(
    configPath,
    JSON.stringify({
      principals: ["fixtures", "other"].map((workspace) => ({
        workspace,
        token: crypto.randomUUID() + crypto.randomUUID(),
      })),
      sandboxToken: crypto.randomUUID() + crypto.randomUUID(),
    }),
  );
  await chmod(configPath, 0o600);
}

const config = configSchema.parse(await Bun.file(configPath).json());

const envPath = resolve(state, "worker.dev.vars");

await Bun.write(
  envPath,
  `LOCAL_AUTH='${JSON.stringify(config.principals)}'\nSANDBOX_TOKEN=${JSON.stringify(config.sandboxToken)}\n`,
);

await chmod(envPath, 0o600);

for (const port of [14870, 14871, 14872, 14873]) {
  await new Promise<void>((done, reject) => {
    const server = createServer();
    server.once("error", () =>
      reject(
        new Error(
          `Port ${port} is occupied. Preserve its owner and choose another local configuration.`,
        ),
      ),
    );
    server.listen(port, "127.0.0.1", () => server.close(() => done()));
  });
}

const environment = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  TMPDIR: process.env.TMPDIR,
  XDG_CONFIG_HOME: resolve(state, "tool-config"),
  WRANGLER_LOG_PATH: resolve(state, "wrangler.log"),
  WRANGLER_REGISTRY_PATH: resolve(state, "registry"),
  WRANGLER_SEND_METRICS: "false",
  BROWSER: "none",
};

const children: ReturnType<typeof Bun.spawn>[] = [];

function launch(name: string, command: string[], extra: Record<string, string> = {}) {
  const child = Bun.spawn(command, {
    cwd: root,
    env: { ...environment, ...extra },
    stdin: "ignore",
    stdout: Bun.file(resolve(state, `${name}.log`)),
    stderr: Bun.file(resolve(state, `${name}.error.log`)),
  });

  children.push(child);

  return child;
}

let closing = false;

function stop() {
  if (closing) {
    return;
  }

  closing = true;

  for (const child of children) {
    child.kill("SIGTERM");
  }
}

process.on("SIGTERM", stop);

process.on("SIGINT", stop);

launch(
  "sandbox",
  [
    process.execPath,
    "--no-env-file",
    "apps/sandbox/src/index.ts",
    "--worktree",
    root,
    "--state-root",
    resolve(state, "sandbox"),
    "--docker-context",
    "colima-loopy-cloud-phase1",
    "--port",
    "14871",
  ],
  { LOOPY_SANDBOX_TOKEN: config.sandboxToken },
);

launch("worker", [
  process.execPath,
  "x",
  "--no-install",
  "wrangler",
  "dev",
  "--local",
  "--config",
  "apps/cloud/wrangler.jsonc",
  "--persist-to",
  resolve(state, "wrangler"),
  "--env-file",
  envPath,
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
    "14872",
    "--strictPort",
  ],
  { LOOPY_API_ORIGIN: "http://127.0.0.1:14870" },
);

await Bun.write(
  resolve(state, "processes.json"),
  JSON.stringify({ owner: process.pid, worktree: root, children: children.map((c) => c.pid) }),
);

console.log(
  "Local cloud starting. API http://127.0.0.1:14870, dashboard http://127.0.0.1:14872. Credentials and logs: .loopy/cloud. Ctrl+C stops these processes.",
);

await Promise.race(children.map((child) => child.exited));

stop();

await Promise.all(children.map((child) => child.exited));
