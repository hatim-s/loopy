import { afterEach } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nodeIdSchema } from "../../src/contract/index.js";
import type { ExecutionSpec } from "../../src/core/index.js";
import { initialState, step } from "../../src/engine/index.js";
import { LocalExecutor } from "../../src/executor/index.js";
import { loopy, sh } from "../../src/sdk/index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

export async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "loopy-executor-")));
  roots.push(root);
  const workspace = join(root, "workspace");
  await Bun.write(join(workspace, "seed"), "workspace");
  const home = join(root, "home");
  await Bun.write(join(home, "bundles", "seed"), "bundle");
  const bundle = join(home, "bundles", "bundle.js");
  const key = { runId: "run", nodeId: nodeIdSchema.parse("0:code"), scope: [] };

  const executor = new LocalExecutor({
    home,
    workspace,
    mode: "sandbox",
    secrets: {},
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
  const graph = loopy("command", { input: {}, run: () => sh(argv) }).graph;

  const dispatch = step(graph, initialState("run", {}), {
    kind: "resume",
    at: "2026-10-18T00:00:00.000Z",
  }).next;

  if (dispatch?.kind !== "dispatch") {
    throw new Error("Expected command dispatch");
  }

  return dispatch.spec;
}
