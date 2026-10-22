import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nodeIdSchema, routes } from "../src/contract/index.js";
import { executionKeyString, type LogRecord, type NodeRun, type Store } from "../src/core/index.js";
import { SYSTEM_CLOCK } from "../src/host/index.js";
import { LoopyService, Registry } from "../src/local/index.js";
import { MemoryStore, SqliteRunStore } from "../src/store/index.js";
import { SCHEMA, WAIT_SCHEMA } from "../src/store/sqlite/store-schema.js";
import { newRun } from "./fixture.js";

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    cleanup();
  }
});

function fixture(memory = false) {
  const root = mkdtempSync(join(tmpdir(), "loopy-query-"));
  const sqlite = memory ? null : new SqliteRunStore(join(root, "runs.sqlite"));
  const store: Store = sqlite ?? new MemoryStore();
  cleanups.push(() => {
    sqlite?.close();
    rmSync(root, { recursive: true, force: true });
  });

  const service = new LoopyService({
    store,
    registry: () => new Registry(root, root),
    clock: SYSTEM_CLOCK,
  });

  return { root, store, service };
}

function node(attempt = 1): NodeRun {
  return {
    key: {
      runId: "run",
      nodeId: nodeIdSchema.parse("work"),
      scope: [{ nodeId: nodeIdSchema.parse("map"), index: 0 }],
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

for (const memory of [false, true]) {
  test(`${memory ? "memory" : "sqlite"} keyset ties, filtered counts and zero-filled fractional windows`, async () => {
    const { store } = fixture(memory);

    for (const id of ["c", "a", "b"]) {
      await store.createRun({ ...newRun(), id, status: "succeeded", output: null });
    }

    const first = await store.queryRuns({ now: newRun().createdAt, limit: 2 });
    expect(first.map((run) => run.id)).toEqual(["c", "b"]);

    const second = await store.queryRuns({
      now: newRun().createdAt,
      limit: 2,
      before: `${first[1]?.createdAt}|${first[1]?.id}`,
    });

    expect(second.map((run) => run.id)).toEqual(["a"]);

    const summary = await store.overview({
      from: "2026-10-15T23:59:59.500Z",
      to: "2026-10-16T00:02:59.500Z",
      bucketSeconds: 60,
    });

    expect(summary.counts.succeeded).toBe(3);
    expect(summary.buckets.map((bucket) => bucket.counts.succeeded)).toEqual([3, 0, 0]);
    expect((await store.runCounts({ slug: "absent" })).succeeded).toBe(0);
  });
  test(`${memory ? "memory" : "sqlite"} input and attempts persist, bulk reads omit input and selected detail keeps it`, async () => {
    const { store, service } = fixture(memory);
    await store.createRun(newRun());
    await store.claim("run", "owner");
    await store.apply({
      runId: "run",
      token: "owner",
      effects: [
        { kind: "write_node_run", nodeRun: node(1) },
        { kind: "write_node_run", nodeRun: node(2) },
      ],
    });
    expect((await store.getNodeRuns("run"))[0]?.inputView).toEqual({
      state: "available",
      value: { name: "attempt-2" },
    });
    const page = await store.nodePage("run", { scope: JSON.stringify(node().key.scope), limit: 1 });
    expect(page.items[0]).not.toHaveProperty("inputView");
    expect(page.items[0]).toMatchObject({ output: null });
    expect(page.truncatedOutputs[executionKeyString(node().key)]).toBe(20002);
    const detail = await store.execution("run", executionKeyString(node().key));
    expect(detail?.node.inputView).toEqual({ state: "available", value: { name: "attempt-2" } });
    expect(detail?.attempts.map((attempt) => attempt.inputView)).toEqual([
      { state: "available", value: { name: "attempt-1" } },
      { state: "available", value: { name: "attempt-2" } },
    ]);
    expect(detail?.truncatedAttempts).toEqual({ "1": 20002, "2": 20002 });
    const snapshot = routes.run.response.parse(await service.runSnapshot("run"));
    expect(snapshot.nodeRuns).toEqual([]);
    expect(snapshot.logs).toEqual([]);
    expect(snapshot.scopes).toMatchObject([
      { total: 1, totalKind: "materialized", counts: { succeeded: 1 } },
    ]);
    const events = await service.events(await store.events(0, 20));
    expect(
      events
        .filter((event) => event.entity === "node")
        .every((event) => !("inputView" in event.record)),
    ).toBe(true);
    const nodeEvent = events.find((event) => event.entity === "node");
    expect(nodeEvent).toMatchObject({ truncatedOutputBytes: 20002, record: { output: null } });
    const lazy = await service.event(nodeEvent?.sequence ?? 0);
    expect(lazy.record).not.toHaveProperty("inputView");
    expect(lazy.record).toMatchObject({ output: "x".repeat(20000) });
  });
}

test("SQLite bounded scans continue through no-match pages and full log text search stays lazy", async () => {
  const { store, service } = fixture();
  await store.createRun(newRun());
  await store.claim("run", "owner");

  const effects = Array.from(Array(2100).keys(), (index) => ({
    kind: "write_log" as const,
    executionKey: { ...node().key, scope: [{ nodeId: nodeIdSchema.parse("map"), index }] },
    attempt: 1,
    log: { message: index === 0 ? `${"x".repeat(1100)}needle` : "hello", data: { index } },
    at: newRun().createdAt,
  }));

  await store.apply({ runId: "run", token: "owner", effects });
  const missing = await store.logPage({ limit: 50, text: "not present" });
  expect(missing.items).toEqual([]);
  expect(missing.scanned).toBe(2000);
  expect(missing.next).not.toBeNull();

  const next = await store.logPage({
    limit: 50,
    text: "needle",
    before: missing.next ?? undefined,
  });

  expect(next.items).toHaveLength(1);
  expect(next.items[0]?.message).not.toContain("needle");
  expect(next.items[0]?.executionKey).toBe(
    effects[0] ? executionKeyString(effects[0].executionKey) : "",
  );
  expect(next.items[0]).not.toHaveProperty("data");
  const detail = await service.log(next.items[0]?.id ?? 0);
  expect(detail.log.message).toContain("needle");
  expect(detail.log.data).toEqual({ index: 0 });
  const newest = await store.logPage({ limit: 200, after: 0 });
  expect(newest.items[0]?.id).toBe(1);
  expect(newest.items.at(-1)?.id).toBe(200);
  expect(newest.next).toBe(200);
  const events = await store.eventPage({ limit: 5, entity: "log" });
  const txn = events.items[0]?.txn;
  expect(txn).toBeDefined();
  expect((await store.eventPage({ limit: 5, txn })).items.every((event) => event.txn === txn)).toBe(
    true,
  );
});

test("schema 14 upgrade preserves epoch, outbox, log identity, output and exact log cap", async () => {
  const root = mkdtempSync(join(tmpdir(), "loopy-v14-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, "runs.sqlite");
  const db = new Database(file);
  db.exec(SCHEMA);
  db.query("INSERT INTO meta VALUES ('epoch','retained')").run();
  db.query(
    "INSERT INTO runs(id,slug,revision,workspace,input_json,status,created_at,updated_at) VALUES ('run','test','bundle','/workspace','{}','queued',?,?)",
  ).run(newRun().createdAt, newRun().createdAt);
  const record = node();
  const key = executionKeyString(record.key);
  db.query("INSERT INTO node_runs VALUES (?,?,?,?,?,?,?,?,?,?)").run(
    "run",
    key,
    1,
    "succeeded",
    record.startedAt,
    record.startedAt,
    JSON.stringify("x".repeat(20000)),
    null,
    "finished",
    JSON.stringify(record),
  );

  const log: LogRecord = {
    runId: "run",
    seq: 1,
    position: { kind: "node", executionKey: key, attempt: 1, index: 0 },
    level: "info",
    message: "x".repeat(65497),
    data: null,
    at: newRun().createdAt,
  };

  db.query("INSERT INTO logs VALUES (?,?,?,?,?,?)").run("run", key, 1, 0, 1, JSON.stringify(log));
  db.query(
    "INSERT INTO events(at,txn,entity,kind,run_id,record) VALUES (?,'retained-txn','node','succeeded','run',?)",
  ).run(record.startedAt, JSON.stringify(record));
  db.exec("PRAGMA user_version=14");
  db.close();
  const store = new SqliteRunStore(file);
  cleanups.push(() => store.close());
  expect(await store.epoch()).toBe("retained");
  expect((await store.logDetail(1))?.log).toEqual(log);
  expect((await store.events(0, 10))[0]?.txn).toBe("retained-txn");
  expect((await store.execution("run", key))?.attempts).toHaveLength(1);
  await store.claim("run", "owner");
  await expect(
    store.apply({
      runId: "run",
      token: "owner",
      effects: [
        {
          kind: "write_log",
          executionKey: record.key,
          attempt: 1,
          log: { message: "a".repeat(50), data: null },
          at: record.startedAt,
        },
      ],
    }),
  ).rejects.toThrow("Attempt logs exceed the 64 KiB limit.");
  expect(await store.getLogs("run")).toHaveLength(1);
});

test("run lists and streamed run records preview large payloads with explicit byte counts", async () => {
  const { store, service } = fixture();
  const large = "x".repeat(100000);
  await store.createRun({ ...newRun(), input: { large }, status: "succeeded", output: { large } });
  const [row] = await service.listRuns({ limit: 50 });
  expect(row).toMatchObject({
    input: null,
    output: null,
    truncatedFields: { input: 100012, output: 100012 },
  });
  const events = await service.events(await store.events(0, 20));
  expect(events[0]?.record).toMatchObject({
    input: null,
    output: null,
    truncatedFields: { input: 100012, output: 100012 },
  });
  const snapshot = await service.runSnapshot("run");
  expect(snapshot.run.truncatedFields).toEqual({ input: 100012, output: 100012 });
  expect(await service.runPayload("run")).toEqual({ input: { large }, output: { large } });
});

test("failed transactional batches roll back retained attempts and log usage with their outbox", async () => {
  const { root, store } = fixture();
  await store.createRun(newRun());
  await store.claim("run", "owner");
  await store.apply({
    runId: "run",
    token: "owner",
    effects: [{ kind: "write_node_run", nodeRun: node(1) }],
  });
  const db = new Database(join(root, "runs.sqlite"));
  db.exec(
    "CREATE TRIGGER reject_finished BEFORE INSERT ON events WHEN NEW.entity='run' AND NEW.kind='finished' BEGIN SELECT RAISE(ABORT,'blocked finish'); END",
  );
  await expect(
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
  ).rejects.toThrow("blocked finish");
  expect(
    (await store.execution("run", executionKeyString(node().key)))?.attempts.map(
      (node) => node.attempt,
    ),
  ).toEqual([1]);
  expect(await store.getLogs("run")).toEqual([]);
  db.exec("DROP TRIGGER reject_finished");
  db.close();
  await store.apply({
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
  });
  expect((await store.getLogs("run"))[0]).toMatchObject({ seq: 1, position: { index: 0 } });
});

test("a rejected schema migration preserves the old records, epoch and version", () => {
  const root = mkdtempSync(join(tmpdir(), "loopy-bad-migration-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, "runs.sqlite");
  const db = new Database(file);
  db.exec(SCHEMA);
  db.query("INSERT INTO meta VALUES ('epoch','keep-me')").run();
  db.query(
    "INSERT INTO events(at,txn,entity,kind,record) VALUES (?,'txn','node','succeeded','{broken')",
  ).run(newRun().createdAt);
  db.exec("PRAGMA user_version=14");
  db.close();
  expect(() => new SqliteRunStore(file)).toThrow("malformed JSON");
  const unchanged = new Database(file, { readonly: true });
  expect(unchanged.query("PRAGMA user_version").get()).toEqual({ user_version: 14 });
  expect(unchanged.query("SELECT value FROM meta WHERE key='epoch'").get()).toEqual({
    value: "keep-me",
  });
  expect(unchanged.query("SELECT record FROM events").get()).toEqual({ record: "{broken" });
  expect(
    unchanged.query("SELECT name FROM sqlite_schema WHERE name='node_attempts'").get(),
  ).toBeNull();
  unchanged.close();
});

for (const version of [13, 14]) {
  test(`schema ${version} log events retain node filtering after migration and agree with new log events`, async () => {
    const root = mkdtempSync(join(tmpdir(), `loopy-v${version}-log-event-`));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const file = join(root, "runs.sqlite");
    const db = new Database(file);
    db.exec(version === 13 ? SCHEMA.replace(WAIT_SCHEMA, "") : SCHEMA);
    db.query("INSERT INTO meta VALUES ('epoch','retained-epoch')").run();
    db.query(
      "INSERT INTO runs(id,slug,revision,workspace,input_json,status,created_at,updated_at) VALUES ('run','test','bundle','/workspace','{}','queued',?,?)",
    ).run(newRun().createdAt, newRun().createdAt);
    const record = node();
    const key = executionKeyString(record.key);
    db.query("INSERT INTO node_runs VALUES (?,?,?,?,?,?,?,?,?,?)").run(
      "run",
      key,
      1,
      record.status,
      record.startedAt,
      record.startedAt,
      JSON.stringify("x".repeat(20000)),
      null,
      record.receipt,
      JSON.stringify(record),
    );

    const log: LogRecord = {
      runId: "run",
      seq: 7,
      position: { kind: "node", executionKey: key, attempt: 1, index: 0 },
      level: "info",
      message: "old log",
      data: null,
      at: newRun().createdAt,
    };

    db.query("INSERT INTO logs VALUES (?,?,?,?,?,?)").run("run", key, 1, 0, 7, JSON.stringify(log));
    db.query(
      "INSERT INTO events(at,txn,entity,kind,run_id,record) VALUES (?,'old-txn','log','written','run',?)",
    ).run(log.at, JSON.stringify(log));
    db.query(
      "INSERT INTO events(at,txn,entity,kind,run_id,record) VALUES (?,'unknown-txn','log','written','run',?)",
    ).run(
      log.at,
      JSON.stringify({ ...log, position: { ...log.position, executionKey: "missing" } }),
    );
    db.exec(`PRAGMA user_version=${version}`);
    db.close();
    const store = new SqliteRunStore(file);
    cleanups.push(() => store.close());
    expect(await store.epoch()).toBe("retained-epoch");
    const migrated = await store.eventPage({ nodeId: "work", limit: 50 });
    expect(migrated.items).toMatchObject([{ txn: "old-txn", nodeId: "work", entity: "log" }]);
    expect(migrated.items).toHaveLength(1);
    expect((await store.logPage({ limit: 50 })).items[0]?.nodeId).toBe("work");
    expect((await store.eventPage({ txn: "unknown-txn", limit: 50 })).items[0]?.nodeId).toBeNull();
    await store.claim("run", "owner");
    await store.apply({
      runId: "run",
      token: "owner",
      effects: [
        {
          kind: "write_log",
          executionKey: record.key,
          attempt: 1,
          log: { message: "new log", data: null },
          at: record.startedAt,
        },
      ],
    });
    const both = await store.eventPage({ nodeId: "work", entity: "log", limit: 50 });
    expect(both.items).toHaveLength(2);
    expect(both.items.every((event) => event.nodeId === "work")).toBe(true);
    expect(both.items.map((event) => event.sequence)).toEqual([4, 1]);
  });
}
