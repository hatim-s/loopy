import { chmod } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { z } from "zod";
import { atomic, type Config, dashboard, profile, root, sandboxState, state } from "./config";

import { receiptBindingsSchema } from "./receipt/bindings";

export const manifestPath = resolve(state, "processes.json");

export function cleanEnvironment() {
  return {
    ...profile.environment,
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

export async function writeStackConfig(settings: Config) {
  const original: unknown = await Bun.file(resolve(root, "apps/cloud/wrangler.jsonc")).json();

  if (profile.name) {
    receiptBindingsSchema.parse(original);
  }

  const wrangler = z
    .object({ vars: z.record(z.string(), z.string()) })
    .passthrough()
    .parse(original);

  const workerVariables = profile.name
    ? { ...wrangler.vars, RECEIPTS_NAMESPACE: profile.batchPrefix, RECEIPTS_ROOT: sandboxState }
    : wrangler.vars;

  await atomic(resolve(state, "wrangler.json"), {
    ...wrangler,
    name: `loopy-${profile.batchPrefix}-local`,
    main: resolve(root, "apps/cloud/src/worker.ts"),
    vars: { ...workerVariables, SANDBOX_URL: profile.sandbox, CONCURRENCY: "4" },
    dev: { ip: "127.0.0.1", port: profile.apiPort, inspector_port: profile.inspectorPort },
  });
  const vars = resolve(state, "worker.dev.vars");
  await Bun.write(
    vars,
    `LOCAL_AUTH='${JSON.stringify([
      { workspace: "playground", token: settings.token },
      { workspace: "other", token: settings.otherToken },
    ])}'\nSANDBOX_TOKEN=${JSON.stringify(settings.sandboxToken)}\n${settings.receiptMode === "durable-object" ? `RECEIPTS_TOKEN=${JSON.stringify(settings.receiptsToken)}\n` : ""}`,
  );
  await chmod(vars, 0o600);
  await Bun.write(
    resolve(state, "dashboard.url"),
    `${dashboard}/#token=${encodeURIComponent(settings.token)}\n`,
  );
  await chmod(resolve(state, "dashboard.url"), 0o600);

  return vars;
}

export async function requireFreePorts() {
  for (const port of [
    profile.apiPort,
    profile.sandboxPort,
    profile.dashboardPort,
    profile.inspectorPort,
  ]) {
    await new Promise<void>((done, reject) => {
      const listener = createServer();
      listener.once("error", () => reject(new Error(`Playground port ${port} is occupied.`)));
      listener.listen(port, "127.0.0.1", () => listener.close(() => done()));
    });
  }
}
