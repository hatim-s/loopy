import { resolve } from "node:path";
import { root } from "./stack/constants";
import { ensureLocalCredentials, localState } from "./stack/credentials";
import { toolEnvironment } from "./stack/environment";
import { type Child, dashboardArgv, launch, sandboxArgv, wranglerArgv } from "./stack/launch";
import { requireFreePorts } from "./stack/ports";
import { writeDevVars } from "./stack/worker-config";

const credentials = await ensureLocalCredentials();

const envPath = resolve(localState, "worker.dev.vars");

await writeDevVars(envPath, credentials);

await requireFreePorts([14870, 14871, 14872, 14873]);

const environment = toolEnvironment(localState);

const children: Child[] = [];

function start(log: string, argv: string[], extra: Record<string, string> = {}) {
  children.push(launch({ argv, env: { ...environment, ...extra }, logs: localState, log }));
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

start(
  "sandbox",
  sandboxArgv({ worktree: root, stateRoot: resolve(localState, "sandbox"), port: 14871 }),
  { LOOPY_SANDBOX_TOKEN: credentials.sandboxToken },
);

start(
  "worker",
  wranglerArgv({
    config: "apps/cloud/wrangler.jsonc",
    persistTo: resolve(localState, "wrangler"),
    envFile: envPath,
  }),
);

start("dashboard", dashboardArgv(14872), { LOOPY_API_ORIGIN: "http://127.0.0.1:14870" });

await Bun.write(
  resolve(localState, "processes.json"),
  JSON.stringify({ owner: process.pid, worktree: root, children: children.map((c) => c.pid) }),
);

console.log(
  "Local cloud starting. API http://127.0.0.1:14870, dashboard http://127.0.0.1:14872. Credentials and logs: .loopy/cloud. Ctrl+C stops these processes.",
);

await Promise.race(children.map((child) => child.exited));

stop();

await Promise.all(children.map((child) => child.exited));
