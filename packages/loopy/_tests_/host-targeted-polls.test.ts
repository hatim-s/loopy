import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nodeIdSchema } from "../src/contract/index.js";
import type { ExecutionKey, NodeRun, Store } from "../src/core/index.js";
import { activateDurable } from "../src/host/durable.js";
import { code, loopy, parallel, sh, wait } from "../src/sdk/graph/index.js";
import { MemoryStore, SqliteRunStore } from "../src/store/index.js";
import { newRun } from "./fixture.js";
import { PolicyProvider, policyGraph, policySuccess } from "./host-policy-fixture.js";

for (const backend of ["memory", "sqlite"] as const) {
  test(`${backend} targeted node reads preserve ordered scopes and detach nested data`, async () => {
    const root = mkdtempSync(join(tmpdir(), "loopy-host-node-"));

    const store =
      backend === "memory" ? new MemoryStore() : new SqliteRunStore(join(root, "runs.sqlite"));

    try {
      await store.createRun(newRun());
      await store.claim("run", "owner");

      const key: ExecutionKey = {
        runId: "run",
        nodeId: nodeIdSchema.parse("work"),
        scope: [
          { nodeId: nodeIdSchema.parse("outer"), index: 1 },
          { nodeId: nodeIdSchema.parse("inner"), index: 2 },
        ],
      };

      const node: NodeRun = {
        key,
        status: "succeeded",
        attempt: 1,
        maxAttempts: 2,
        receipt: "finished",
        startedAt: newRun().createdAt,
        endedAt: newRun().createdAt,
        output: { nested: [42] },
      };

      await store.apply({
        runId: "run",
        token: "owner",
        effects: [{ kind: "write_node_run", nodeRun: node }],
      });
      expect(await store.getNodeRun({ ...key, runId: "missing" })).toBeUndefined();
      expect(await store.getNodeRun({ ...key, scope: [...key.scope].reverse() })).toBeUndefined();
      expect(
        await store.getNodeRun({
          ...key,
          scope: [{ nodeId: nodeIdSchema.parse("outer"), index: 0 }, ...key.scope.slice(1)],
        }),
      ).toBeUndefined();
      const read = await store.getNodeRun(key);
      expect(read).toEqual(node);

      if (read?.status !== "succeeded") {
        throw new Error("Expected succeeded node.");
      }

      read.key.scope.reverse();
      read.output = { nested: [0] };
      expect(await store.getNodeRun(key)).toEqual(node);
    } finally {
      if (store instanceof SqliteRunStore) {
        store.close();
      }

      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("started-only turns use two full reads plus B targeted reads without extra receipt writes", async () => {
  class CountingStore extends MemoryStore {
    full = 0;
    targeted = 0;
    batches: Parameters<Store["apply"]>[0][] = [];

    override async getNodeRuns(runId: string) {
      this.full++;

      return super.getNodeRuns(runId);
    }

    override async getNodeRun(key: ExecutionKey) {
      this.targeted++;

      return super.getNodeRun(key);
    }

    override async apply(batch: Parameters<Store["apply"]>[0]) {
      this.batches.push(batch);

      return super.apply(batch);
    }
  }

  let now = Date.parse(newRun().createdAt);
  const store = new CountingStore(() => now, 3000);
  const provider = new PolicyProvider();

  const graph = loopy("wide", {
    input: {},
    run: () =>
      parallel(
        Object.fromEntries(
          [...Array.from({ length: 9 }).keys()].map((index) => [
            `work${index}`,
            () =>
              code(`work${index}`, {
                in: {},
                out: { kind: "value", type: "number" },
                module: "./work.ts",
              }),
          ]),
        ),
      ),
  }).graph;

  for (const node of graph.nodes) {
    if (node.kind === "code") {
      node.module.bundleHash = "a".repeat(64);
    }
  }

  await store.createRun(newRun());

  const turn = (cursor: string | null, maxWork = 3) =>
    activateDurable({
      store,
      provider,
      graph,
      runId: "run",
      token: "owner",
      at: new Date(now).toISOString(),
      maxWork,
      cursor,
      pollMs: 1000,
    });

  let result = await turn(null, 9);
  expect(provider.starts).toHaveLength(9);
  expect(
    store.batches.filter(
      (batch) => batch.effects.length === 1 && batch.effects[0]?.kind === "write_node_run",
    ),
  ).toHaveLength(9);
  provider.lookups = [];

  for (let count = 0; count < 3; count++) {
    store.full = 0;
    store.targeted = 0;
    store.batches = [];
    now += 500;
    result = await turn(result.cursor);
    expect(store.full).toBe(2);
    expect(store.targeted).toBe(3);
    // The reconstruction batch remains. Receipt polls must add no second batch.
    expect(store.batches).toHaveLength(1);
    expect(result.nextWakeAt).toBe(new Date(now + 1000).toISOString());
    expect((await store.getRun("run"))?.owner?.heartbeatAt).toBe(new Date(now).toISOString());
  }

  expect(new Set(provider.lookups).size).toBe(9);
  expect(provider.starts).toHaveLength(9);
  await expect(store.claim("run", "foreign")).rejects.toThrow("not owned by this token");
});

for (const observation of ["completion", "denial"] as const) {
  test(`a signal during ${observation} is read before reduction`, async () => {
    const store = new MemoryStore();
    const provider = new PolicyProvider();

    const graph =
      observation === "completion"
        ? policyGraph()
        : loopy("limited", {
            input: {},
            run: () =>
              parallel({
                work: () => sh(["true"], { rateLimit: { key: "limit", limit: 1, window: "1m" } }),
                approval: () => wait("approve", { payload: { kind: "value", type: "boolean" } }),
              }),
          }).graph;

    const at = newRun().createdAt;
    await store.createRun(newRun());

    const signal = async () => {
      const hook = (await store.getWaits("run"))[0];

      if (!hook) {
        throw new Error("Expected persisted wait.");
      }

      expect(await store.resolveWait({ token: hook.token, payload: true, at })).toMatchObject({
        kind: "resolved",
      });
    };

    const options = { store, provider, graph, at, runId: "run", token: "owner" };

    if (observation === "completion") {
      await activateDurable(options);
      provider.lookup = async () => {
        await signal();

        return { kind: "finished", result: policySuccess };
      };

      expect(await activateDurable(options)).toMatchObject({
        outcome: { status: "succeeded", output: { work: 42, approval: true } },
      });
    } else {
      await store.acquireRateLimit("limit", 1, 60_000, at);
      const acquire = store.acquireRateLimit.bind(store);
      store.acquireRateLimit = async (...args) => {
        await signal();

        return acquire(...args);
      };

      expect(await activateDurable(options)).toMatchObject({ status: "pending" });
      expect(await store.getNodeRuns("run")).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ status: "succeeded", output: true }),
          expect.objectContaining({ status: "rate_limited", attempt: 1 }),
        ]),
      );
      expect(provider.starts).toHaveLength(0);
    }
  });
}
