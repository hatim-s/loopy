import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { nodeIdSchema } from "@loopy/contract";
import type { ExecutionSpec } from "@loopy/core";
import { initialState, step } from "@loopy/core/engine";
import { loopy, sh } from "@loopy/sdk/graph";
import { Schema } from "effect";
import { LocalExecutor } from "../../src/executor";
import { qualityTestRoot } from "./quality-test-root";

export async function fixture() {
  const root = qualityTestRoot("executor", { outsideCheckout: true });
  const workspace = join(root, "workspace");
  await mkdir(join(workspace, ".loopy", "loopies"), { recursive: true });
  await Bun.write(join(workspace, "seed"), "workspace");
  const home = join(root, "home");
  await Bun.write(join(home, "bundles", "seed"), "bundle");
  const bundle = join(home, "bundles", "bundle.js");
  const key = { runId: "run", nodeId: Schema.decodeUnknownSync(nodeIdSchema)("0:code"), scope: [] };

  const executor = new LocalExecutor({
    home,
    workspace,
    mode: "sandbox",
    secrets: [],
    bundlePath: () => bundle,
  });

  const spec: ExecutionSpec = {
    kind: "code",
    bundleHash: "a".repeat(64),
    input: { name: "Hatim" },
    timeoutMs: 3000,
  };

  return { root, home, workspace, bundle, key, executor, spec };
}

export function commandSpec(argv: readonly string[]): ExecutionSpec {
  const graph = loopy("command", { input: {}, run: () => sh(argv) });

  const dispatch = step(graph, initialState("run", {}), {
    kind: "run_started",
    at: "2026-10-18T00:00:00.000Z",
  }).effects.find((effect) => effect.kind === "dispatch");

  if (dispatch?.kind !== "dispatch") {
    throw new Error("Expected command dispatch");
  }

  return dispatch.spec;
}
