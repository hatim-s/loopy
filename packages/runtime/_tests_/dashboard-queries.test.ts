import { expect, test } from "bun:test";
import { decodeBoundary, nodeIdSchema, routes } from "@loopy/contract";
import { executionKeyString, type NodeRun } from "@loopy/core";
import { Effect } from "effect";
import { newRun } from "../../core/_tests_/fixtures/run";
import { makeLocalService } from "../src/local";
import { qualityTestRoot } from "./fixtures/quality-test-root";
import { memoryStore } from "./fixtures/stores";

function fixture() {
  const root = qualityTestRoot("query");
  const store = memoryStore();

  const service = makeLocalService({
    store,
    home: root,
  });

  return { root, store, service };
}

function node(attempt = 1): NodeRun {
  return {
    key: {
      runId: "run",
      nodeId: decodeBoundary(nodeIdSchema)("work"),
      scope: [{ nodeId: decodeBoundary(nodeIdSchema)("map"), index: 0 }],
    },
    attempt,
    maxAttempts: 3,
    status: "succeeded",
    startedAt: newRun().createdAt,
    endedAt: newRun().createdAt,
    receipt: "finished",
    output: "x".repeat(20000),
    inputView: { state: "available", value: { name: `attempt-${attempt}` } },
  };
}

test("keyset ties, filtered counts and zero-filled fractional windows", async () => {
  const { store } = fixture();

  for (const id of ["c", "a", "b"]) {
    await Effect.runPromise(
      store.createRun({ ...newRun(), id, status: "succeeded", output: null }),
    );
  }

  const first = await Effect.runPromise(store.queryRuns({ now: newRun().createdAt, limit: 2 }));
  expect(first.map((run) => run.id)).toEqual(["c", "b"]);

  const second = await Effect.runPromise(
    store.queryRuns({
      now: newRun().createdAt,
      limit: 2,
      before: `${first[1]?.createdAt}|${first[1]?.id}`,
    }),
  );

  expect(second.map((run) => run.id)).toEqual(["a"]);

  const query = {
    from: "2026-10-15T23:59:59.500Z",
    to: "2026-10-16T00:02:59.500Z",
    bucketSeconds: 60,
  };

  const summary = await Effect.runPromise(store.overview(query));
  expect(summary.counts.succeeded).toBe(3);
  expect(summary.buckets.map((bucket) => bucket.counts.succeeded)).toEqual([3, 0, 0]);
  expect(
    (await Effect.runPromise(store.overview({ ...query, slug: "absent" }))).counts.succeeded,
  ).toBe(0);
});

test("input and attempts persist, bulk reads omit input and selected detail keeps it", async () => {
  const { store, service } = fixture();
  await Effect.runPromise(store.createRun(newRun()));
  await Effect.runPromise(store.claim("run", "owner"));
  await Effect.runPromise(
    store.apply({
      runId: "run",
      token: "owner",
      effects: [
        { kind: "write_node_run", nodeRun: node(1) },
        { kind: "write_node_run", nodeRun: node(2) },
      ],
    }),
  );
  expect((await Effect.runPromise(store.getNodeRuns("run")))[0]?.inputView).toEqual({
    state: "available",
    value: { name: "attempt-2" },
  });

  const page = await Effect.runPromise(
    store.nodePage("run", { scope: JSON.stringify(node().key.scope), limit: 1 }),
  );

  expect(page.items[0]).not.toHaveProperty("inputView");
  expect(page.items[0]).toMatchObject({ output: null });
  expect(page.truncatedOutputs[executionKeyString(node().key)]).toBe(20002);
  const detail = await Effect.runPromise(store.execution("run", executionKeyString(node().key)));
  expect(detail?.node.inputView).toEqual({ state: "available", value: { name: "attempt-2" } });
  expect(detail?.attempts.map((attempt) => attempt.inputView)).toEqual([
    { state: "available", value: { name: "attempt-1" } },
    { state: "available", value: { name: "attempt-2" } },
  ]);
  expect(detail?.truncatedAttempts).toEqual({ "1": 20002, "2": 20002 });

  const snapshot = decodeBoundary(routes.run.response)(
    await Effect.runPromise(service.runSnapshot("run")),
  );

  expect(snapshot.nodeRuns).toEqual([]);
  expect(await Effect.runPromise(service.scopes("run", { parentScope: "[]" }))).toMatchObject([
    { total: 1, totalKind: "materialized", counts: { succeeded: 1 } },
  ]);

  const events = await Effect.runPromise(
    service.events(await Effect.runPromise(store.events(0, 20))),
  );

  expect(
    events
      .filter((event) => event.entity === "node")
      .every((event) => !("inputView" in event.record)),
  ).toBe(true);
  const nodeEvent = events.find((event) => event.entity === "node");
  expect(nodeEvent).toMatchObject({ truncatedOutputBytes: 20002, record: { output: null } });
  const lazy = await Effect.runPromise(service.event(nodeEvent?.sequence ?? 0));
  expect(lazy.record).not.toHaveProperty("inputView");
  expect(lazy.record).toMatchObject({ output: "x".repeat(20000) });
});

test("SQLite bounded scans continue through no-match pages and full log text search stays lazy", async () => {
  const { store, service } = fixture();
  await Effect.runPromise(store.createRun(newRun()));
  await Effect.runPromise(store.claim("run", "owner"));

  const effects = Array.from(Array(2100).keys(), (index) => ({
    kind: "write_log" as const,
    executionKey: {
      ...node().key,
      scope: [{ nodeId: decodeBoundary(nodeIdSchema)("map"), index }],
    },
    attempt: 1,
    log: { message: index === 0 ? `${"x".repeat(1100)}needle` : "hello", data: { index } },
    at: newRun().createdAt,
  }));

  await Effect.runPromise(store.apply({ runId: "run", token: "owner", effects }));
  const missing = await Effect.runPromise(store.logPage({ limit: 50, text: "not present" }));
  expect(missing.items).toEqual([]);
  expect(missing.scanned).toBe(2000);
  expect(missing.next).not.toBeNull();

  const next = await Effect.runPromise(
    store.logPage({
      limit: 50,
      text: "needle",
      before: missing.next ?? undefined,
    }),
  );

  expect(next.items).toHaveLength(1);
  expect(next.items[0]?.message).not.toContain("needle");
  expect(next.items[0]?.executionKey).toBe(
    effects[0] ? executionKeyString(effects[0].executionKey) : "",
  );
  expect(next.items[0]).not.toHaveProperty("data");
  const detail = await Effect.runPromise(service.log(next.items[0]?.id ?? 0));
  expect(detail.log.message).toContain("needle");
  expect(detail.log.data).toEqual({ index: 0 });
  const newest = await Effect.runPromise(store.logPage({ limit: 200, after: 0 }));
  expect(newest.items[0]?.id).toBe(1);
  expect(newest.items.at(-1)?.id).toBe(200);
  expect(newest.next).toBe(200);
  const events = await Effect.runPromise(store.eventPage({ limit: 5, entity: "log" }));
  const txn = events.items[0]?.txn;
  expect(txn).toBeDefined();
  expect(
    (await Effect.runPromise(store.eventPage({ limit: 5, txn }))).items.every(
      (event) => event.txn === txn,
    ),
  ).toBe(true);
});

test("run lists and streamed run records preview large payloads with explicit byte counts", async () => {
  const { store, service } = fixture();
  const large = "x".repeat(100000);
  await Effect.runPromise(
    store.createRun({ ...newRun(), input: { large }, status: "succeeded", output: { large } }),
  );
  const [row] = (await Effect.runPromise(service.listRuns({ limit: 50 }))).runs;
  expect(row).toMatchObject({
    input: null,
    output: null,
    truncatedFields: { input: 100012, output: 100012 },
  });

  const events = await Effect.runPromise(
    service.events(await Effect.runPromise(store.events(0, 20))),
  );

  expect(events[0]?.record).toMatchObject({
    input: null,
    output: null,
    truncatedFields: { input: 100012, output: 100012 },
  });
  const snapshot = await Effect.runPromise(service.runSnapshot("run"));
  expect(snapshot.run.truncatedFields).toEqual({ input: 100012, output: 100012 });
  expect(await Effect.runPromise(service.runPayload("run"))).toEqual({
    input: { large },
    output: { large },
  });
});

test("failed transactional batches roll back retained attempts and log usage with their outbox", async () => {
  const { store } = fixture();
  await Effect.runPromise(store.createRun(newRun()));
  await Effect.runPromise(store.claim("run", "owner"));
  await Effect.runPromise(
    store.apply({
      runId: "run",
      token: "owner",
      effects: [{ kind: "write_node_run", nodeRun: node(1) }],
    }),
  );
  store.driver.exec(
    "CREATE TRIGGER reject_finished BEFORE INSERT ON events WHEN NEW.entity='run' AND NEW.kind='finished' BEGIN SELECT RAISE(ABORT,'blocked finish'); END",
  );
  await expect(
    Effect.runPromise(
      store.apply({
        runId: "run",
        token: "owner",
        effects: [
          { kind: "write_node_run", nodeRun: node(2) },
          {
            kind: "write_log",
            executionKey: node().key,
            attempt: 1,
            log: { message: "x".repeat(60000), data: null },
            at: newRun().createdAt,
          },
          {
            kind: "finish_run",
            outcome: { status: "succeeded", output: null },
            at: newRun().createdAt,
          },
        ],
      }),
    ),
  ).rejects.toThrow("blocked finish");
  expect(
    (await Effect.runPromise(store.execution("run", executionKeyString(node().key))))?.attempts.map(
      (node) => node.attempt,
    ),
  ).toEqual([1]);
  expect(await Effect.runPromise(store.getLogs("run"))).toEqual([]);
  store.driver.exec("DROP TRIGGER reject_finished");
  await Effect.runPromise(
    store.apply({
      runId: "run",
      token: "owner",
      effects: [
        {
          kind: "write_log",
          executionKey: node().key,
          attempt: 1,
          log: { message: "x".repeat(60000), data: null },
          at: newRun().createdAt,
        },
      ],
    }),
  );
  expect((await Effect.runPromise(store.getLogs("run")))[0]).toMatchObject({
    seq: 1,
    position: { index: 0 },
  });
});
