import { createHash } from "node:crypto";
import { resolve } from "node:path";

export const root = resolve(import.meta.dir, "../../..");

export const state = resolve(root, ".loopy/cloud-failures");

export const runtime = resolve(state, "runtime-root");

export const sandboxState = resolve(runtime, ".loopy/cloud/sandbox");

export const owner = createHash("sha256").update(sandboxState).digest("hex");

export const api = "http://127.0.0.1:14970";

export const sandbox = "http://127.0.0.1:14971";

export const environment = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  TMPDIR: process.env.TMPDIR,
  XDG_CONFIG_HOME: resolve(state, "tool-config"),
  WRANGLER_LOG_PATH: resolve(state, "wrangler.log"),
  WRANGLER_REGISTRY_PATH: resolve(state, "registry"),
  WRANGLER_SEND_METRICS: "false",
  BROWSER: "none",
};
