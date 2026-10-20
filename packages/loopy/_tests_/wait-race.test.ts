import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nodeIdSchema } from "../src/contract/index.js";
import type { NodeRun, Store } from "../src/core/index.js";
import { activate, type Clock } from "../src/host/index.js";
import { loopy, wait } from "../src/sdk/graph/index.js";
import { MemoryStore, SqliteRunStore } from "../src/store/index.js";
import { FakeExecutor, newRun } from "./fixture.js";

const homes: string[] = [];

const sqliteStores: SqliteRunStore[] = [];

const at = "2026-10-20T00:00:00.000Z";

const future = "2026-10-20T00:01:00.000Z";

const clock: Clock = {
  now: () => Date.parse(at),
  timeout: (callback, milliseconds) => {
    const timer = setTimeout(callback, milliseconds);

    return () => clearTimeout(timer);
  },
};

afterEach(() => {
  for (const store of sqliteStores.splice(0)) {
    store.close();
  }

  for (const home of homes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});

function createStore(kind: "memory" | "sqlite"): Store {
  if (kind === "memory") {
    return new MemoryStore(clock.now);
  }

  const home = mkdtempSync(join(tmpdir(), "loopy-wait-race-"));
  homes.push(home);
  const store = new SqliteRunStore(join(home, "runs.sqlite"), clock.now);
  sqliteStores.push(store);

  return store;
}

const graph = loopy("race", {
  input: {},
  run: () => wait("approve", { payload: { kind: "value", type: "boolean" } }),
}).graph;

async function prepare(store: Store) {
  await store.createRun({ ...newRun(), input: {} });
  expect(
    await activate({ store, clock, graph, executor: new FakeExecutor(), runId: "run" }),
  ).toEqual({ status: "suspended" });
  const hook = (await store.getWaits("run"))[0];

  if (!hook) {
    throw new Error("Expected a persisted wait.");
  }

  return hook;
}

for (const kind of ["memory", "sqlite"] as const) {
  for (const wakeAt of [null, future]) {
    test(`${kind} stale ${wakeAt === null ? "indefinite" : "finite"} suspension preserves a signal across running-node writes`, async () => {
      const store = createStore(kind);
      const hook = await prepare(store);
      await store.claim("run", "owner");
      expect((await store.resolveWait({ token: hook.token, payload: true, at })).kind).toBe(
        "resolved",
      );

      const sibling: NodeRun = {
        key: { runId: "run", nodeId: nodeIdSchema.parse("sibling"), scope: [] },
        status: "running",
        attempt: 1,
        maxAttempts: 1,
        startedAt: at,
        receipt: "none",
      };

      await store.apply({
        runId: "run",
        token: "owner",
        effects: [
          { kind: "write_node_run", nodeRun: sibling },
          {
            kind: "write_node_run",
            nodeRun: { ...sibling, status: "succeeded", output: null, endedAt: at },
          },
          { kind: "suspend_run", wakeAt, at },
        ],
      });
      await store.release("run", "owner");
      expect(await store.getRun("run")).toMatchObject({ status: "suspended", wakeAt: at });
      expect(await store.nextWakeAt()).toBe(at);
      expect((await store.dueRuns(at)).map((run) => run.id)).toEqual(["run"]);
      expect(await store.getWait(hook.token)).toMatchObject({ resolvedAt: at, payload: true });
      expect((await store.resolveWait({ token: hook.token, payload: false, at })).kind).toBe(
        "rejected",
      );
    });
  }

  test(`${kind} stale suspension keeps an earlier deadline instead of postponing it`, async () => {
    const store = createStore(kind);
    await prepare(store);
    await store.claim("run", "owner");
    await store.apply({
      runId: "run",
      token: "owner",
      effects: [
        { kind: "schedule_retry", at: future },
        { kind: "suspend_run", wakeAt: at, at },
      ],
    });
    await store.release("run", "owner");
    expect(await store.nextWakeAt()).toBe(at);
  });

  test(`${kind} signal between activation reload and suspension remains due and completes`, async () => {
    const store = createStore(kind);
    const hook = await prepare(store);
    const apply = store.apply.bind(store);
    let injected = false;
    store.apply = async (batch) => {
      if (!injected && batch.effects.some((effect) => effect.kind === "suspend_run")) {
        injected = true;
        expect((await store.resolveWait({ token: hook.token, payload: true, at })).kind).toBe(
          "resolved",
        );
      }

      await apply(batch);
    };

    expect(
      await activate({ store, clock, graph, executor: new FakeExecutor(), runId: "run" }),
    ).toEqual({ status: "suspended" });
    expect(injected).toBe(true);
    expect((await store.getNodeRuns("run"))[0]?.status).toBe("succeeded");
    expect(await store.nextWakeAt()).toBe(at);
    expect((await store.dueRuns(at)).map((run) => run.id)).toEqual(["run"]);
    expect(
      await activate({ store, clock, graph, executor: new FakeExecutor(), runId: "run" }),
    ).toEqual({ status: "succeeded", output: true });
  });
}
