import { afterEach, expect, test } from "bun:test";
import { nodeIdSchema } from "@loopy/contract";
import type { RuntimeEvent, Store } from "@loopy/core";
import { makeSqliteRunStore } from "@loopy/runtime/store";
import { Effect, Exit, Schema, Scope } from "effect";
import { subscribeStore } from "../../runtime/src/host/subscription";
import { newRun } from "./fixture";
import { runAt } from "./store-fixture";

const scopes: Scope.Closeable[] = [];

afterEach(async () => {
  for (const scope of scopes.splice(0).reverse()) {
    await Effect.runPromise(Scope.close(scope, Exit.void));
  }
});

function fixtureScope() {
  const scope = Scope.makeUnsafe();
  scopes.push(scope);

  return scope;
}

const start = Date.parse(newRun().createdAt);

const make = () =>
  Effect.runPromise(
    makeSqliteRunStore(":memory:").pipe(Effect.provideService(Scope.Scope, fixtureScope())),
  );

test("subscribers survive throwing listeners and unsubscribe after committed batches", async () => {
  const store = await make();

  const batches: RuntimeEvent[][] = [];
  const reads: Promise<Effect.Success<ReturnType<Store["getRun"]>>>[] = [];
  await Effect.runPromise(
    subscribeStore(store, () => {
      throw new Error("Listener failed.");
    }).pipe(Effect.provideService(Scope.Scope, fixtureScope())),
  );

  const subscription = fixtureScope();
  await Effect.runPromise(
    subscribeStore(store, (events) => {
      batches.push(events);
      reads.push(Effect.runPromise(store.getRun("run")));
    }).pipe(Effect.provideService(Scope.Scope, subscription)),
  );

  await Effect.runPromise(store.createRun(newRun()));
  expect(await reads[0]).toEqual(newRun());
  await Effect.runPromise(store.claim("run", "owner"));
  expect(batches.map((batch) => batch.length)).toEqual([1, 1]);
  await Effect.runPromise(Scope.close(subscription, Exit.void));
  await Effect.runPromise(
    store.apply({
      runId: "run",
      token: "owner",
      effects: [
        {
          kind: "finish_run",
          outcome: { status: "succeeded", output: null },
          at: newRun().createdAt,
        },
      ],
    }),
  );
  expect(batches).toHaveLength(2);
  expect(await Effect.runPromise(store.events(0, 10))).toHaveLength(3);
});

test("retention keeps the exact 24-hour boundary and monotonic sequences", async () => {
  let time = start;
  const run = runAt(() => time);
  const store = await make();

  await run(store.createRun(newRun()));
  time++;
  await run(store.claim("run", "owner"));
  time += 86_400_000;
  expect(await run(store.pruneEvents(new Date(time).toISOString()))).toBe(1);
  expect((await run(store.events(0, 10))).map((event) => event.sequence)).toEqual([2]);
  expect(await run(store.pruneEvents(new Date(time).toISOString()))).toBe(0);
  await run(store.heartbeat("run", "owner"));
  expect((await run(store.events(2, 10)))[0]?.sequence).toBe(3);
});

test("retention bounds recent rows to the newest 100000", async () => {
  const store = await make();

  await Effect.runPromise(store.createRun(newRun()));
  await Effect.runPromise(store.claim("run", "owner"));

  for (let index = 0; index < 100_001; index++) {
    await Effect.runPromise(store.heartbeat("run", "owner"));
  }

  expect(await Effect.runPromise(store.pruneEvents(newRun().createdAt))).toBe(3);
  const events = await Effect.runPromise(store.events(0, 100_010));
  expect(events).toHaveLength(100_000);
  expect(events[0]?.sequence).toBe(4);
  expect(events.at(-1)?.sequence).toBe(100_003);
}, 30_000);

test("graph node, log and run events commit in reducer order within one transaction", async () => {
  const store = await make();
  const run = runAt(() => start);
  await run(store.createRun(newRun()));
  await run(store.claim("run", "owner"));
  const key = { runId: "run", nodeId: Schema.decodeUnknownSync(nodeIdSchema)("0:code"), scope: [] };

  const node = {
    key,
    attempt: 1,
    maxAttempts: 1,
    startedAt: newRun().createdAt,
    receipt: "finished" as const,
  };

  await run(
    store.apply({
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
    }),
  );
  await run(store.release("run", "owner"));
  const events = await run(store.events(0, 100));
  expect(events.slice(2, 6).every((event) => event.txn === events[2]?.txn)).toBe(true);
  expect(new Set(events.map((event) => event.txn)).size).toBe(4);
  expect(await run(store.events(2, 2))).toEqual(events.slice(2, 4));
  expect(
    events.map((event) => [event.sequence, event.entity, event.kind, event.runId, event.at]),
  ).toEqual([
    [1, "run", "created", "run", node.startedAt],
    [2, "run", "claimed", "run", node.startedAt],
    [3, "node", "running", "run", node.startedAt],
    [4, "log", "written", "run", node.startedAt],
    [5, "node", "succeeded", "run", node.startedAt],
    [6, "run", "finished", "run", node.startedAt],
    [7, "run", "released", "run", node.startedAt],
  ]);
});
