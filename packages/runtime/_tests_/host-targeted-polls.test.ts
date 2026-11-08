import { expect, test } from "bun:test";
import { nodeIdSchema } from "@loopy/contract";
import type { ExecutionKey, NodeRun, Store } from "@loopy/core";
import { code, loopy, parallel, sh, wait } from "@loopy/sdk/graph";
import { Effect, Schema } from "effect";
import { newRun } from "../../core/_tests_/fixtures/run";
import { activateDurable } from "../src/host";
import { PolicyProvider, policyGraph, policySuccess } from "./fixtures/host-policy";
import { MemorySqlStore, memoryStore, runAt } from "./fixtures/stores";

test("targeted node reads preserve ordered scopes and detach nested data", async () => {
  const store = memoryStore();

  await Effect.runPromise(store.createRun(newRun()));
  await Effect.runPromise(store.claim("run", "owner"));

  const key: ExecutionKey = {
    runId: "run",
    nodeId: Schema.decodeUnknownSync(nodeIdSchema)("work"),
    scope: [
      { nodeId: Schema.decodeUnknownSync(nodeIdSchema)("outer"), index: 1 },
      { nodeId: Schema.decodeUnknownSync(nodeIdSchema)("inner"), index: 2 },
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

  await Effect.runPromise(
    store.apply({
      runId: "run",
      token: "owner",
      effects: [{ kind: "write_node_run", nodeRun: node }],
    }),
  );
  expect(await Effect.runPromise(store.getNodeRun({ ...key, runId: "missing" }))).toBeUndefined();
  expect(
    await Effect.runPromise(store.getNodeRun({ ...key, scope: [...key.scope].reverse() })),
  ).toBeUndefined();
  expect(
    await Effect.runPromise(
      store.getNodeRun({
        ...key,
        scope: [
          { nodeId: Schema.decodeUnknownSync(nodeIdSchema)("outer"), index: 0 },
          ...key.scope.slice(1),
        ],
      }),
    ),
  ).toBeUndefined();
  const read = await Effect.runPromise(store.getNodeRun(key));
  expect(read).toEqual(node);

  if (read?.status !== "succeeded") {
    throw new Error("Expected succeeded node.");
  }

  read.key.scope.reverse();
  read.output = { nested: [0] };
  expect(await Effect.runPromise(store.getNodeRun(key))).toEqual(node);
});

test("started-only turns use two full reads plus B targeted reads without extra receipt writes", async () => {
  class CountingStore extends MemorySqlStore {
    full = 0;
    targeted = 0;
    batches: Parameters<Store["apply"]>[0][] = [];

    override getNodeRuns(runId: string) {
      const base = super.getNodeRuns(runId);

      return Effect.gen({ self: this }, function* () {
        this.full++;

        return yield* base;
      });
    }

    override getNodeRun(key: ExecutionKey) {
      const base = super.getNodeRun(key);

      return Effect.gen({ self: this }, function* () {
        this.targeted++;

        return yield* base;
      });
    }

    override apply(batch: Parameters<Store["apply"]>[0]) {
      const base = super.apply(batch);

      return Effect.gen({ self: this }, function* () {
        this.batches.push(batch);

        return yield* base;
      });
    }
  }

  let now = Date.parse(newRun().createdAt);
  const run = runAt(() => now);
  const store = new CountingStore({ leaseMs: 4000 });
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
  });

  for (const node of graph.nodes) {
    if (node.kind === "code") {
      node.module.bundleHash = "a".repeat(64);
    }
  }

  await run(store.createRun(newRun()));

  const turn = (cursor: string | null, maxWork = 3) =>
    run(
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
      }),
    );

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
    expect((await run(store.getRun("run")))?.owner?.heartbeatAt).toBe(new Date(now).toISOString());
  }

  expect(new Set(provider.lookups).size).toBe(9);
  expect(provider.starts).toHaveLength(9);
  await expect(run(store.claim("run", "foreign"))).rejects.toThrow("not owned by this token");
});

for (const observation of ["completion", "denial"] as const) {
  test(`a signal during ${observation} is read before reduction`, async () => {
    const store = memoryStore();
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
          });

    const at = newRun().createdAt;
    await Effect.runPromise(store.createRun(newRun()));

    const signal = async () => {
      const hook = (await Effect.runPromise(store.getWaits("run")))[0];

      if (!hook) {
        throw new Error("Expected persisted wait.");
      }

      expect(
        await Effect.runPromise(store.resolveWait({ token: hook.token, payload: true, at })),
      ).toMatchObject({
        kind: "resolved",
      });
    };

    const options = {
      store,
      provider,
      graph,
      at,
      runId: "run",
      token: "owner",
      maxWork: 32,
      pollMs: 1000,
    };

    if (observation === "completion") {
      await Effect.runPromise(activateDurable(options));
      provider.lookup = () => {
        return Effect.gen(function* () {
          yield* Effect.promise(() => signal());

          return { kind: "finished" as const, result: policySuccess };
        }).pipe(Effect.orDie);
      };

      expect(await Effect.runPromise(activateDurable(options))).toMatchObject({
        outcome: { status: "succeeded", output: { work: 42, approval: true } },
      });
    } else {
      await Effect.runPromise(store.acquireRateLimit("limit", 1, 60_000, at));
      const acquire = store.acquireRateLimit.bind(store);
      store.acquireRateLimit = (...args) => {
        return Effect.gen(function* () {
          yield* Effect.promise(() => signal());

          return yield* acquire(...args);
        });
      };

      expect(await Effect.runPromise(activateDurable(options))).toMatchObject({
        status: "pending",
      });
      expect(await Effect.runPromise(store.getNodeRuns("run"))).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ status: "succeeded", output: true }),
          expect.objectContaining({ status: "rate_limited", attempt: 1 }),
        ]),
      );
      expect(provider.starts).toHaveLength(0);
    }
  });
}
