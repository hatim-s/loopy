import { expect, test } from "bun:test";
import { activateDurable } from "../src/host/durable.js";
import { loopy, sh } from "../src/sdk/graph/index.js";
import { MemoryStore } from "../src/store/index.js";
import { newRun } from "./fixture.js";
import { PolicyProvider } from "./host-policy-fixture.js";

test("an admission denial reloads state and cannot overwrite a newer persisted attempt", async () => {
  const store = new MemoryStore();
  const provider = new PolicyProvider();

  const graph = loopy("limited", {
    input: {},
    run: () => sh(["true"], { rateLimit: { key: "shared", limit: 1, window: "1m" } }),
  }).graph;

  const at = newRun().createdAt;
  await store.createRun(newRun());
  await store.acquireRateLimit("shared", 1, 60_000, at);
  provider.lookup = async (key) => {
    const previous = await store.getNodeRun(key);

    if (!previous) {
      throw new Error("Expected committed attempt.");
    }

    await store.apply({
      runId: "run",
      token: "owner",
      effects: [{ kind: "write_node_run", nodeRun: { ...previous, attempt: 2 } }],
    });

    return { kind: "none" };
  };

  expect(
    await activateDurable({ store, provider, graph, runId: "run", token: "owner", at }),
  ).toMatchObject({ status: "pending" });
  expect(await store.getNodeRuns("run")).toMatchObject([{ status: "running", attempt: 2 }]);
  expect(provider.starts).toEqual([]);
  expect(await store.getLogs("run")).toEqual([]);
});
