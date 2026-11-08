import { resolve } from "node:path";
import { decodeBoundary } from "@loopy/contract";
import { Schema } from "effect";
import { SANDBOX_IMAGE } from "../../../sandbox/src/docker/identity";
import { sandboxStateRoot } from "../../../sandbox/src/state-root";
import { stackPorts } from "../stack/ports";

const profileNameSchema = Schema.UndefinedOr(Schema.Literal("architecture"));

function paths(root: string, suffix: string, apiPort: number) {
  const state = resolve(root, `.loopy/playground${suffix}`);
  const runtime = resolve(state, "runtime-root");
  const ports = stackPorts(apiPort);

  return {
    root,
    state,
    runtime,
    sandboxState: sandboxStateRoot(runtime),
    repository: resolve(state, "loopies-playground"),
    batchPrefix: `playground${suffix}`,
    apiPort,
    sandboxPort: ports.sandbox,
    dashboardPort: ports.dashboard,
    inspectorPort: ports.inspector,
    api: ports.origin("api"),
    dashboard: ports.origin("dashboard"),
    sandbox: ports.origin("sandbox"),
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
