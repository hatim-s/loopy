import { afterEach } from "bun:test";
import { mkdir, realpath, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { nodeIdSchema } from "../../src/contract/index.js";
import type { ExecutionSpec } from "../../src/core/index.js";
import { LocalExecutor } from "../../src/executor/local.js";
import { FilesystemReceipts } from "../../src/executor/receipts.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

export async function receiptsFixture() {
  const root = resolve(
    import.meta.dir,
    "../../../../.loopy/architecture-tests",
    `local-receipts-${crypto.randomUUID()}`,
  );

  await mkdir(root, { recursive: true, mode: 0o700 });
  roots.push(root);
  const home = await realpath(root);
  const workspace = resolve(home, "workspace");
  const receiptHome = resolve(home, "home");
  await mkdir(workspace, { mode: 0o700 });
  await mkdir(receiptHome, { mode: 0o700 });
  const bundle = resolve(receiptHome, "bundle.js");
  const key = { runId: "run", nodeId: nodeIdSchema.parse("0:code"), scope: [] };
  const identity = { executionKey: key, attempt: 1 };
  const receipts = new FilesystemReceipts(receiptHome);

  const executor = new LocalExecutor({
    home: receiptHome,
    workspace,
    mode: "sandbox",
    secrets: [],
    bundlePath: () => bundle,
    receipts,
  });

  const spec: ExecutionSpec = {
    kind: "code",
    bundleHash: "a".repeat(64),
    input: {},
    timeoutMs: 3000,
  };

  return {
    root: home,
    home: receiptHome,
    workspace,
    bundle,
    key,
    identity,
    receipts,
    executor,
    spec,
  };
}
