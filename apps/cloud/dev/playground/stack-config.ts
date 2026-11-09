import { chmod } from "node:fs/promises";
import { resolve } from "node:path";
import { toolEnvironment } from "../stack/environment";
import { requireFreePorts } from "../stack/ports";
import { writeDevVars, writeWorkerConfig } from "../stack/worker-config";
import { type Config, dashboard, profile, sandboxState, state } from "./config";
import { CONCURRENCY } from "./plan";
import { profilePorts } from "./profile";

export const manifestPath = resolve(state, "processes.json");

export function cleanEnvironment() {
  return toolEnvironment(state, profile.environment);
}

export async function writeStackConfig(settings: Config) {
  const receipts: Record<string, string> =
    settings.receiptMode === "durable-object"
      ? { RECEIPTS_NAMESPACE: profile.batchPrefix, RECEIPTS_ROOT: sandboxState }
      : {};

  await writeWorkerConfig({
    path: resolve(state, "wrangler.json"),
    name: `loopy-${profile.batchPrefix}-local`,
    vars: { ...receipts, SANDBOX_URL: profile.sandbox, CONCURRENCY: String(CONCURRENCY) },
    apiPort: profile.apiPort,
    inspectorPort: profile.inspectorPort,
  });

  const vars = resolve(state, "worker.dev.vars");

  const secrets = {
    principals: [
      { workspace: "playground", token: settings.token },
      { workspace: "other", token: settings.otherToken },
    ],
    sandboxToken: settings.sandboxToken,
  };

  await writeDevVars(
    vars,
    settings.receiptMode === "durable-object"
      ? { ...secrets, receiptsToken: settings.receiptsToken }
      : secrets,
  );
  const url = resolve(state, "dashboard.url");
  await Bun.write(url, `${dashboard}/#token=${encodeURIComponent(settings.token)}\n`);
  await chmod(url, 0o600);

  return vars;
}

export function requireFreeStackPorts() {
  return requireFreePorts(profilePorts(profile));
}
