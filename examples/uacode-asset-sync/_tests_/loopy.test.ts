import { expect, test } from "bun:test";
import { FakeExecutor, startLoopy } from "../../../packages/loopy/_tests_/fixture.js";
import { MemoryRunStore } from "../../../packages/loopy/src/runtime/index.js";
import definition from "../asset-sync-pr.loopy.ts";

test("asset sync snapshots a request and passes it to the runner as stdin", async () => {
  const store = new MemoryRunStore();
  const executor = new FakeExecutor();
  executor.result.stdout = '{"dryRun":true}';
  expect(
    await startLoopy({
      loopy: definition,
      input: { requestFile: "/requests/asset sync.json" },
      store,
      executor,
      runId: "sync",
      bundleHash: "fixture",
      workspace: "/workspace",
    }),
  ).toMatchObject({ status: "succeeded" });
  expect(executor.calls).toMatchObject([
    { program: "cat", args: ["--", "/requests/asset sync.json"] },
    { program: "bun", args: ["examples/uacode-asset-sync/run.ts", "-"], stdin: '{"dryRun":true}' },
  ]);
  expect(await store.getSteps("sync")).toMatchObject([
    { key: "fs.cat" },
    { key: "sh.run", maxAttempts: 1 },
  ]);
  expect(await store.getLogs("sync")).toMatchObject([
    { message: "Asset synchronization completed." },
  ]);
});
