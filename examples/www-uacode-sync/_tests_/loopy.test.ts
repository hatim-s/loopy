import { expect, test } from "bun:test";
import { FakeExecutor } from "../../../packages/loopy/_tests_/engine-fixture.js";
import { MemoryRunStore } from "../../../packages/loopy/src/runtime/index.js";
import { startLoopy } from "../../../packages/loopy/src/sdk/host.js";
import definition from "../www-uacode-sync.loopy.ts";

for (const dryRun of [true, false]) {
  test(`www sync records dryRun=${dryRun} in its command and log`, async () => {
    const store = new MemoryRunStore();
    const executor = new FakeExecutor();
    expect(
      await startLoopy({
        loopy: definition,
        input: { dryRun },
        store,
        executor,
        runId: "sync",
        bundleHash: "fixture",
        workspace: "/workspace",
      }),
    ).toMatchObject({ status: "succeeded" });
    expect(executor.calls).toMatchObject([
      {
        program: "bun",
        args: ["run", "examples/www-uacode-sync/sync.ts", "--dry-run", String(dryRun)],
      },
    ]);
    expect(await store.getSteps("sync")).toMatchObject([{ key: "sh.run", maxAttempts: 1 }]);
    expect(await store.getLogs("sync")).toMatchObject([{ data: { dryRun } }]);
  });
}
