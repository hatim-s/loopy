import { expect, test } from "bun:test";
import { nodeIdSchema } from "../src/contract/index.js";
import type { RuntimeEvent, Store } from "../src/core/index.js";
import { MemoryStore, SqliteRunStore } from "../src/store/index.js";
import { newRun } from "./fixture.js";

const start = Date.parse(newRun().createdAt);

const factories = [
  { name: "memory", make: (now: () => number) => new MemoryStore(now) },
  { name: "sqlite", make: (now: () => number) => new SqliteRunStore(":memory:", now) },
];

for (const { name, make } of factories) {
  test(`${name} subscribers survive throwing listeners and unsubscribe after committed batches`, async () => {
    const store = make(() => start);

    try {
      const batches: RuntimeEvent[][] = [];
      const reads: ReturnType<Store["getRun"]>[] = [];
      store.subscribe(() => {
        throw new Error("Listener failed.");
      });

      const unsubscribe = store.subscribe((events) => {
        batches.push(events);
        reads.push(store.getRun("run"));
      });

      await store.createRun(newRun());
      expect(await reads[0]).toEqual(newRun());
      await store.claim("run", "owner");
      expect(batches.map((batch) => batch.length)).toEqual([1, 1]);
      unsubscribe();
      await store.finishRun("run", "owner", { status: "succeeded", output: null });
      expect(batches).toHaveLength(2);
      expect(await store.events(0, 10)).toHaveLength(3);
    } finally {
      if (store instanceof SqliteRunStore) {
        store.close();
      }
    }
  });

  test(`${name} retention keeps the exact 24-hour boundary and monotonic sequences`, async () => {
    let time = start;
    const store = make(() => time);

    try {
      await store.createRun(newRun());
      time++;
      await store.claim("run", "owner");
      time += 86_400_000;
      expect(await store.pruneEvents(new Date(time).toISOString())).toBe(1);
      expect((await store.events(0, 10)).map((event) => event.sequence)).toEqual([2]);
      expect(await store.pruneEvents(new Date(time).toISOString())).toBe(0);
      await store.heartbeat("run", "owner");
      expect((await store.events(2, 10))[0]?.sequence).toBe(3);
    } finally {
      if (store instanceof SqliteRunStore) {
        store.close();
      }
    }
  });

  test(`${name} retention bounds recent rows to the newest 100000`, async () => {
    const store = make(() => start);

    try {
      await store.createRun(newRun());
      await store.claim("run", "owner");

      for (let index = 0; index < 100_001; index++) {
        await store.heartbeat("run", "owner");
      }

      expect(await store.pruneEvents(newRun().createdAt)).toBe(3);
      const events = await store.events(0, 100_010);
      expect(events).toHaveLength(100_000);
      expect(events[0]?.sequence).toBe(4);
      expect(events.at(-1)?.sequence).toBe(100_003);
    } finally {
      if (store instanceof SqliteRunStore) {
        store.close();
      }
    }
  }, 30_000);
}

async function trace(store: Store) {
  await store.createRun(newRun());
  await store.claim("run", "owner");
  const key = { runId: "run", nodeId: nodeIdSchema.parse("0:code"), scope: [] };

  const node = {
    key,
    attempt: 1,
    maxAttempts: 1,
    startedAt: newRun().createdAt,
    receipt: "finished" as const,
  };

  await store.apply({
    runId: "run",
    token: "owner",
    effects: [
      { kind: "write_node_run", nodeRun: { ...node, status: "running" } },
      {
        kind: "write_log",
        executionKey: key,
        attempt: 1,
        log: { message: "hello", data: { nested: [1] } },
        at: node.startedAt,
      },
      {
        kind: "write_node_run",
        nodeRun: { ...node, status: "succeeded", output: 42, endedAt: node.startedAt },
      },
      { kind: "finish_run", outcome: { status: "succeeded", output: 42 }, at: node.startedAt },
    ],
  });
  await store.release("run", "owner");
  const events = await store.events(0, 100);
  expect(events.slice(2, 6).every((event) => event.txn === events[2]?.txn)).toBe(true);
  expect(new Set(events.map((event) => event.txn)).size).toBe(4);
  expect(await store.events(2, 2)).toEqual(events.slice(2, 4));

  return events.map((event) => [event.sequence, event.entity, event.kind, event.runId, event.at]);
}

test("memory and SQLite emit equivalent graph node, log and run event ordering", async () => {
  const sqlite = new SqliteRunStore(":memory:", () => start);

  try {
    const memoryOrder = await trace(new MemoryStore(() => start));
    expect(memoryOrder.map((row) => row.slice(1, 4))).toEqual([
      ["run", "created", "run"],
      ["run", "claimed", "run"],
      ["node", "running", "run"],
      ["log", "written", "run"],
      ["node", "succeeded", "run"],
      ["run", "finished", "run"],
      ["run", "released", "run"],
    ]);
    expect(await trace(sqlite)).toEqual(memoryOrder);
  } finally {
    sqlite.close();
  }
});
