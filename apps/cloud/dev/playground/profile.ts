import { resolve } from "node:path";
import { z } from "zod";

const profileNameSchema = z.literal("architecture").optional();

export function playgroundProfile(root: string, input: string | undefined) {
  const name = profileNameSchema.parse(input);
  const suffix = name ? `-${name}` : "";
  const state = resolve(root, `.loopy/playground${suffix}`);
  const runtime = resolve(state, "runtime-root");
  const apiPort = name ? 15270 : 15070;
  const sandboxPort = apiPort + 1;
  const dashboardPort = apiPort + 2;
  const inspectorPort = apiPort + 3;

  return {
    name,
    state,
    runtime,
    sandboxState: resolve(runtime, ".loopy/cloud/sandbox"),
    repository: resolve(state, "loopies-playground"),
    evidence: resolve(root, ".notes/cloud/evidence", name ?? ""),
    apiPort,
    sandboxPort,
    dashboardPort,
    inspectorPort,
    api: `http://127.0.0.1:${apiPort}`,
    dashboard: `http://127.0.0.1:${dashboardPort}`,
    sandbox: `http://127.0.0.1:${sandboxPort}`,
    image: name ? "loopy-sandbox:architecture-bun-1.4.0" : "loopy-sandbox:bun-1.4.0",
    receiptMode: name ? "durable-object" : "filesystem",
    batchPrefix: `playground${suffix}`,
    environment: name ? { LOOPY_PLAYGROUND_PROFILE: name } : {},
  } as const;
}
