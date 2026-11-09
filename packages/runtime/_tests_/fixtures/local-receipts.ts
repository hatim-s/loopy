import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { nodeIdSchema } from "@loopy/contract";
import type { ExecutionSpec } from "@loopy/core";
import { Schema } from "effect";
import { LocalExecutor } from "../../src/executor/local";
import { FilesystemReceipts } from "../../src/executor/receipts";
import { qualityTestRoot } from "./quality-test-root";

export async function receiptsFixture() {
  const home = qualityTestRoot("local-receipts");
  const workspace = resolve(home, "workspace");
  const receiptHome = resolve(home, "home");
  await mkdir(workspace, { mode: 0o700 });
  await mkdir(resolve(workspace, ".loopy/loopies"), { recursive: true });
  await mkdir(receiptHome, { mode: 0o700 });
  const bundle = resolve(receiptHome, "bundle.js");
  const key = { runId: "run", nodeId: Schema.decodeUnknownSync(nodeIdSchema)("0:code"), scope: [] };
  const identity = { executionKey: key, attempt: 1 };
  const receipts = new FilesystemReceipts(receiptHome);

  const executor = new LocalExecutor({
    home: receiptHome,
    workspace,
    mode: "sandbox",
    secrets: [],
    bundlePath: () => bundle,
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
