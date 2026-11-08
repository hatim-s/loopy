import { resolve } from "node:path";
import { decodeBoundary } from "@loopy/contract";
import { Schema } from "effect";
import { SANDBOX_IMAGE } from "../stack/constants";

const profileNameSchema = Schema.UndefinedOr(Schema.Literal("architecture"));

function paths(root: string, suffix: string, apiPort: number) {
  const state = resolve(root, `.loopy/playground${suffix}`);
  const runtime = resolve(state, "runtime-root");

  return {
    root,
    state,
    runtime,
    sandboxState: resolve(runtime, ".loopy/cloud/sandbox"),
    repository: resolve(state, "loopies-playground"),
    batchPrefix: `playground${suffix}`,
    apiPort,
    sandboxPort: apiPort + 1,
    dashboardPort: apiPort + 2,
    inspectorPort: apiPort + 3,
    api: `http://127.0.0.1:${apiPort}`,
    dashboard: `http://127.0.0.1:${apiPort + 2}`,
    sandbox: `http://127.0.0.1:${apiPort + 1}`,
  };
}

const noEnvironment: Record<string, string> = {};

// The default profile keeps the original filesystem receipt stack; architecture isolates every
// path and port and selects the Durable Object receipt authority.
export function playgroundProfile(root: string, input: string | undefined) {
  const name = decodeBoundary(profileNameSchema)(input);

  if (name === undefined) {
    return {
      ...paths(root, "", 15070),
      name,
      label: "default",
      evidence: resolve(root, ".notes/cloud/evidence"),
      image: SANDBOX_IMAGE,
      receiptMode: "filesystem",
      environment: noEnvironment,
      stopCommand: "bun --no-env-file apps/cloud/dev/playground/index.ts stop",
    } as const;
  }

  return {
    ...paths(root, `-${name}`, 15270),
    name,
    label: name,
    evidence: resolve(root, ".notes/cloud/evidence", name),
    image: "loopy-sandbox:architecture-bun-1.4.0",
    receiptMode: "durable-object",
    environment: { LOOPY_PLAYGROUND_PROFILE: name },
    stopCommand: `LOOPY_PLAYGROUND_PROFILE=${name} bun --no-env-file apps/cloud/dev/playground/index.ts stop`,
  } as const;
}

export type PlaygroundProfile = ReturnType<typeof playgroundProfile>;

export function profilePorts(profile: PlaygroundProfile) {
  return [profile.apiPort, profile.sandboxPort, profile.dashboardPort, profile.inspectorPort];
}
