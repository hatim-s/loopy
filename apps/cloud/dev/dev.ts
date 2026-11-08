import { resolve } from "node:path";
import { root } from "./stack/constants";
import { ensureLocalCredentials, localState } from "./stack/credentials";
import { toolEnvironment } from "./stack/environment";
import { type Child, dashboardArgv, launch, sandboxArgv, wranglerArgv } from "./stack/launch";
import { LOCAL_STACK, requireFreePorts } from "./stack/ports";
import { writeDevVars } from "./stack/worker-config";

const credentials = await ensureLocalCredentials();

const envPath = resolve(localState, "worker.dev.vars");

await writeDevVars(envPath, credentials);

await requireFreePorts(LOCAL_STACK.list);

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

start("sandbox", sandboxArgv({ worktree: root, port: LOCAL_STACK.sandbox }), {
  LOOPY_SANDBOX_TOKEN: credentials.sandboxToken,
});

start(
  "worker",
  wranglerArgv({
    config: "apps/cloud/wrangler.jsonc",
    persistTo: resolve(localState, "wrangler"),
    envFile: envPath,
  }),
);

start("dashboard", dashboardArgv(LOCAL_STACK.dashboard), {
  LOOPY_API_ORIGIN: LOCAL_STACK.origin("api"),
});

await Bun.write(
  resolve(localState, "processes.json"),
  JSON.stringify({ owner: process.pid, worktree: root, children: children.map((c) => c.pid) }),
);

console.log(
  `Local cloud starting. API ${LOCAL_STACK.origin("api")}, dashboard ${LOCAL_STACK.origin("dashboard")}. Credentials and logs: .loopy/cloud. Ctrl+C stops these processes.`,
);

await Promise.race(children.map((child) => child.exited));

stop();

await Promise.all(children.map((child) => child.exited));
