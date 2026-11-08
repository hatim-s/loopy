import { resolve } from "node:path";

// Children get an allowlist so personal Wrangler config, tokens and registries never leak in.
export function toolEnvironment(state: string, extra: Record<string, string> = {}) {
  return {
    ...extra,
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
