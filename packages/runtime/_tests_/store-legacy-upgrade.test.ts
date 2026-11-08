import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { join } from "node:path";
import { decodeBoundary, nodeIdSchema } from "@loopy/contract";
import { executionKeyString, type LogRecord, type NodeRun } from "@loopy/core";
import { Effect, Scope } from "effect";
import { newRun } from "../../core/_tests_/fixtures/run";
import { makeSqliteRunStore } from "../src/store";
import { BunSqlDriver } from "../src/store/bun-driver";
import { qualityTestRoot } from "./fixtures/quality-test-root";
import { legacyDatabase, schema15Database } from "./fixtures/sqlite/legacy";
import { closeTestStore, openTestStore } from "./fixtures/stores";
import { fixtureScope, onCleanup } from "./fixtures/test-scope";

const at = newRun().createdAt;

const later = "2030-01-01T00:00:00.000Z";

const openStore = (file: string) =>
  Effect.runPromise(
    makeSqliteRunStore(file).pipe(Effect.provideService(Scope.Scope, fixtureScope())),
  );

function node(): NodeRun {
  return {
    key: {
      runId: "run",
      nodeId: decodeBoundary(nodeIdSchema)("work"),
      scope: [{ nodeId: decodeBoundary(nodeIdSchema)("map"), index: 0 }],
    },
    attempt: 1,
    maxAttempts: 3,
    status: "succeeded",
    startedAt: at,
    endedAt: at,
    receipt: "finished",
    output: "x".repeat(20000),
    inputView: { state: "available", value: { name: "attempt-1" } },
  };
}

function seedNode(db: Database, record: NodeRun, log: LogRecord) {
  const key = executionKeyString(record.key);
  db.query(
    "INSERT INTO runs(id,slug,revision,workspace,input_json,status,created_at,updated_at) VALUES ('run','test','bundle','/workspace','{}','queued',?,?)",
  ).run(at, at);
  db.query("INSERT INTO node_runs VALUES (?,?,?,?,?,?,?,?,?,?)").run(
    "run",
    key,
    1,
    record.status,
    record.startedAt,
    record.startedAt,
    JSON.stringify(record.status === "succeeded" ? record.output : null),
    null,
    record.receipt,
    JSON.stringify(record),
  );
  db.query("INSERT INTO logs VALUES (?,?,?,?,?,?)").run(
    "run",
    key,
    1,
    0,
    log.seq,
    JSON.stringify(log),
  );
}

function nodeLog(seq: number, message: string): LogRecord {
  return {
    runId: "run",
    seq,
    position: { kind: "node", executionKey: executionKeyString(node().key), attempt: 1, index: 0 },
    level: "info",
    message,
    data: null,
    at,
  };
}

test("schema 13 upgrades to the fresh tables, indexes and records", async () => {
  const home = qualityTestRoot("schema13");
  const file = join(home, "runs.sqlite");
  const db = legacyDatabase(file, 13);
  db.query("INSERT INTO meta VALUES ('epoch','retained-epoch')").run();
  db.query(
    "INSERT INTO runs(id,slug,revision,workspace,input_json,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",
  ).run("run", "test", "bundle", "/workspace", "{}", "queued", at, at);
  db.close();

  const upgraded = openTestStore(file);
  expect(await Effect.runPromise(upgraded.epoch())).toBe("retained-epoch");
  expect(await Effect.runPromise(upgraded.getRun("run"))).toMatchObject({ id: "run" });
  expect(await Effect.runPromise(upgraded.getWaits("run"))).toEqual([]);
  closeTestStore(upgraded);

  const freshFile = join(home, "fresh.sqlite");
  closeTestStore(openTestStore(freshFile));
  const fresh = new BunSqlDriver(freshFile);
  const legacy = new BunSqlDriver(file);
  onCleanup(() => {
    fresh.close();
    legacy.close();
  });
  expect(legacy.query("PRAGMA user_version").get()).toEqual({ user_version: 0 });
  expect(legacy.query("SELECT value FROM meta WHERE key='schema_version'").get()).toEqual({
    value: "16",
  });

  const tables = fresh
    .query<{ name: string }, []>("SELECT name FROM sqlite_schema WHERE type='table'")
    .all();

  const indexes = (db: BunSqlDriver, name: string) =>
    db
      .query<{ name: string }, []>(`PRAGMA index_list('${name}')`)
      .all()
      .map((row) => ({
        name: row.name,
        columns: db.query(`PRAGMA index_info('${row.name}')`).all(),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

  for (const { name } of tables) {
    expect(fresh.query(`PRAGMA table_info('${name}')`).all()).toEqual(
      legacy.query(`PRAGMA table_info('${name}')`).all(),
    );
    expect(fresh.query(`PRAGMA foreign_key_list('${name}')`).all()).toEqual(
      legacy.query(`PRAGMA foreign_key_list('${name}')`).all(),
    );
    expect(indexes(fresh, name)).toEqual(indexes(legacy, name));
  }
});

test("schema 14 upgrade preserves epoch, outbox, log identity, output and exact log cap", async () => {
  const file = join(qualityTestRoot("v14"), "runs.sqlite");
  const db = legacyDatabase(file, 14);
  db.query("INSERT INTO meta VALUES ('epoch','retained')").run();
  const record = node();
  const log = { ...nodeLog(1, "x".repeat(65497)) };
  seedNode(db, record, log);
  db.query(
    "INSERT INTO events(at,txn,entity,kind,run_id,record) VALUES (?,'retained-txn','node','succeeded','run',?)",
  ).run(at, JSON.stringify(record));
  db.close();

  const store = openTestStore(file);
  expect(await Effect.runPromise(store.epoch())).toBe("retained");
  expect((await Effect.runPromise(store.logDetail(1)))?.log).toEqual(log);
  expect(await Effect.runPromise(store.events(0, 10))).toMatchObject([
    { sequence: 1, txn: "retained-txn", record },
  ]);
  expect(
    (await Effect.runPromise(store.execution("run", executionKeyString(record.key))))?.attempts,
  ).toHaveLength(1);
  await Effect.runPromise(store.claim("run", "owner"));
  await expect(
    Effect.runPromise(
      store.apply({
        runId: "run",
        token: "owner",
        effects: [
          {
            kind: "write_log",
            executionKey: record.key,
            attempt: 1,
            log: { message: "a".repeat(50), data: null },
            at,
          },
        ],
      }),
    ),
  ).rejects.toThrow("Attempt logs exceed the 64 KiB limit.");
  expect(await Effect.runPromise(store.getLogs("run"))).toHaveLength(1);
});

for (const version of [13, 14] as const) {
  test(`schema ${version} log events keep node filtering and agree with new log events`, async () => {
    const file = join(qualityTestRoot(`v${version}-log-event`), "runs.sqlite");
    const db = legacyDatabase(file, version);
    db.query("INSERT INTO meta VALUES ('epoch','retained-epoch')").run();
    const record = node();
    const log = nodeLog(7, "old log");
    seedNode(db, record, log);
    db.query(
      "INSERT INTO events(at,txn,entity,kind,run_id,record) VALUES (?,'old-txn','log','written','run',?)",
    ).run(at, JSON.stringify(log));
    db.query(
      "INSERT INTO events(at,txn,entity,kind,run_id,record) VALUES (?,'unknown-txn','log','written','run',?)",
    ).run(at, JSON.stringify({ ...log, position: { ...log.position, executionKey: "missing" } }));
    db.close();

    const store = openTestStore(file);
    expect(await Effect.runPromise(store.epoch())).toBe("retained-epoch");
    const migrated = await Effect.runPromise(store.eventPage({ nodeId: "work", limit: 50 }));
    expect(migrated.items).toMatchObject([{ txn: "old-txn", nodeId: "work", entity: "log" }]);
    expect(migrated.items).toHaveLength(1);
    expect((await Effect.runPromise(store.logPage({ limit: 50 }))).items[0]?.nodeId).toBe("work");
    expect(
      (await Effect.runPromise(store.eventPage({ txn: "unknown-txn", limit: 50 }))).items[0]
        ?.nodeId,
    ).toBeNull();
    await Effect.runPromise(store.claim("run", "owner"));
    await Effect.runPromise(
      store.apply({
        runId: "run",
        token: "owner",
        effects: [
          {
            kind: "write_log",
            executionKey: record.key,
            attempt: 1,
            log: { message: "new log", data: null },
            at,
          },
        ],
      }),
    );

    const both = await Effect.runPromise(
      store.eventPage({ nodeId: "work", entity: "log", limit: 50 }),
    );

    expect(both.items.map((event) => [event.nodeId, event.sequence])).toEqual([
      ["work", 4],
      ["work", 1],
    ]);
  });
}

for (const version of [13, 14, 15] as const) {
  test(`schema ${version} keeps schedules, events and epoch and adds the overview index`, async () => {
    const file = join(qualityTestRoot("schedule-v"), "runs.sqlite");
    const db = version === 15 ? schema15Database(file) : legacyDatabase(file, version);
    // Local schema 15 homes from before the meta marker also predate the overview index.
    db.exec(`PRAGMA user_version=${version}`);
    db.exec("DROP INDEX IF EXISTS schedules_enabled_next");
    db.exec("INSERT OR REPLACE INTO meta VALUES ('epoch','schedule-retained')");
    db.query(
      "INSERT INTO schedules(workspace,slug,cron,tz,input_json,enabled,last_fire_key,next_fire_at,version) VALUES ('/b','shared','@daily','UTC','{\"retained\":true}',1,'old-fire',?,9)",
    ).run(later);
    db.query(
      "INSERT INTO events(at,txn,entity,kind,run_id,record) VALUES (?,'schedule-retained-txn','schedule','deleted',NULL,?)",
    ).run(later, '{"workspace":"/a","slug":"old"}');
    db.close();

    const store = await openStore(file);
    expect(await Effect.runPromise(store.epoch())).toBe("schedule-retained");
    expect((await Effect.runPromise(store.listSchedules()))[0]).toMatchObject({
      workspace: "/b",
      slug: "shared",
      version: 9,
      lastFireKey: "old-fire",
      input: { retained: true },
    });
    expect((await Effect.runPromise(store.events(0, 10)))[0]?.txn).toBe("schedule-retained-txn");
    expect((await Effect.runPromise(store.scheduleOverview())).active).toBe(1);
    await Effect.runPromise(store.close());

    const persisted = new Database(file);
    expect(persisted.query("PRAGMA user_version").get()).toEqual({ user_version: 0 });
    expect(persisted.query("SELECT value FROM meta WHERE key='schema_version'").get()).toEqual({
      value: "16",
    });

    const plans = persisted
      .query<{ detail: string }, []>(
        "EXPLAIN QUERY PLAN SELECT workspace,slug,cron,tz,next_fire_at FROM schedules WHERE enabled=1 ORDER BY next_fire_at,workspace,slug LIMIT 10",
      )
      .all();

    expect(plans.some((plan) => plan.detail.includes("schedules_enabled_next"))).toBe(true);
    expect(plans.some((plan) => plan.detail.includes("TEMP B-TREE"))).toBe(false);
    persisted.close();

    const reopened = await openStore(file);
    expect(await Effect.runPromise(reopened.epoch())).toBe("schedule-retained");
    expect((await Effect.runPromise(reopened.listSchedules()))[0]?.version).toBe(9);
  });
}

const run = {
  id: "run",
  slug: "test",
  revision: "bundle",
  workspace: "/workspace",
  input: {},
  createdAt: at,
  updatedAt: at,
};

const owner = { token: "owner", pid: 7, host: "host", heartbeatAt: at };

const schedule = {
  version: 3,
  workspace: "/workspace",
  slug: "test",
  cron: "@daily",
  tz: "UTC",
  input: {},
  enabled: true,
  lastFireKey: "fire",
  nextFireAt: later,
};

const hook = { token: "token", runId: "run", seq: 1, name: "approve", createdAt: at };

// Each kind lists the records schema 15 wrote for it and the schema 16 records they read back as.
const schema15Events: {
  entity: string;
  kind: string;
  records: { stored: object; read: object }[];
}[] = [
  {
    entity: "run",
    kind: "created",
    records: [{ stored: { ...run, status: "queued" }, read: { ...run, status: "queued" } }],
  },
  {
    entity: "run",
    kind: "claimed",
    records: [
      { stored: { ...run, status: "running", owner }, read: { ...run, status: "running", owner } },
    ],
  },
  {
    entity: "run",
    kind: "heartbeat",
    records: [
      {
        stored: { ...run, status: "running", owner, nextRetryAt: later },
        read: { ...run, status: "running", owner },
      },
    ],
  },
  {
    entity: "run",
    kind: "suspended",
    records: [
      {
        stored: { ...run, status: "suspended", owner },
        read: { ...run, status: "suspended", owner, wakeAt: null },
      },
      {
        stored: { ...run, status: "suspended", owner, wakeAt: later, nextRetryAt: later },
        read: { ...run, status: "suspended", owner, wakeAt: later },
      },
    ],
  },
  {
    entity: "run",
    kind: "woken",
    records: [
      { stored: { ...run, status: "queued", wakeAt: at }, read: { ...run, status: "queued" } },
    ],
  },
  {
    entity: "run",
    kind: "released",
    records: [
      {
        stored: { ...run, status: "suspended" },
        read: { ...run, status: "suspended", wakeAt: null },
      },
    ],
  },
  {
    entity: "run",
    kind: "finished",
    records: [
      {
        stored: { ...run, status: "succeeded", output: { ok: true } },
        read: { ...run, status: "succeeded", output: { ok: true } },
      },
      {
        stored: { ...run, status: "failed", error: "boom" },
        read: { ...run, status: "failed", error: "boom" },
      },
      { stored: { ...run, status: "cancelled" }, read: { ...run, status: "cancelled" } },
    ],
  },
  { entity: "node", kind: "succeeded", records: [{ stored: node(), read: node() }] },
  {
    entity: "log",
    kind: "written",
    records: [{ stored: nodeLog(1, "line"), read: nodeLog(1, "line") }],
  },
  { entity: "hook", kind: "created", records: [{ stored: hook, read: hook }] },
  {
    entity: "hook",
    kind: "resolved",
    records: [
      {
        stored: { ...hook, payload: { ok: true }, resolvedAt: at },
        read: { ...hook, payload: { ok: true }, resolvedAt: at },
      },
    ],
  },
  {
    entity: "hook",
    kind: "expired",
    records: [{ stored: { ...hook, expiredAt: at }, read: { ...hook, expiredAt: at } }],
  },
  ...(["saved", "fired"] as const).map((kind) => ({
    entity: "schedule",
    kind,
    records: [{ stored: schedule, read: { ...schedule, failure: null } }],
  })),
  {
    entity: "schedule",
    kind: "deleted",
    records: [
      {
        stored: { workspace: "/workspace", slug: "test" },
        read: { workspace: "/workspace", slug: "test" },
      },
    ],
  },
];

for (const { entity, kind, records } of schema15Events) {
  test(`schema 15 ${entity} ${kind} events read back in the schema 16 shape with history intact`, async () => {
    const file = join(qualityTestRoot(`schema15-${entity}-${kind}`), "runs.sqlite");
    const db = schema15Database(file);
    db.query("INSERT INTO meta VALUES ('epoch','retained-epoch')").run();

    const insert = db.query(
      "INSERT INTO events(at,txn,entity,kind,run_id,record) VALUES (?,?,?,?,?,?)",
    );

    records.forEach(({ stored }, index) => {
      insert.run(
        at,
        `txn-${index}`,
        entity,
        kind,
        entity === "schedule" ? null : "run",
        JSON.stringify(stored),
      );
    });
    db.close();

    const store = await openStore(file);
    expect(await Effect.runPromise(store.epoch())).toBe("retained-epoch");
    // Widened so the expectation can state each record exactly as JSON.
    const events: unknown[] = await Effect.runPromise(store.events(0, 100));
    expect(events).toEqual(
      records.map(({ read }, index) => ({
        sequence: index + 1,
        at,
        txn: `txn-${index}`,
        entity,
        kind,
        runId: entity === "schedule" ? null : "run",
        record: read,
      })),
    );
  });
}

test("a rejected schema migration preserves the old records, epoch and version", async () => {
  const file = join(qualityTestRoot("bad-migration"), "runs.sqlite");
  const db = legacyDatabase(file, 14);
  db.query("INSERT INTO meta VALUES ('epoch','keep-me')").run();
  db.query(
    "INSERT INTO events(at,txn,entity,kind,record) VALUES (?,'txn','node','succeeded','{broken')",
  ).run(at);
  db.close();
  await expect(openStore(file)).rejects.toThrow("malformed JSON");

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

test("an unsupported legacy schema is rejected without resetting its data", async () => {
  const file = join(qualityTestRoot("legacy-reject"), "legacy.sqlite");
  const old = new Database(file);
  old.exec(
    "CREATE TABLE sacred (value TEXT); INSERT INTO sacred VALUES ('retain'); PRAGMA user_version=11",
  );
  old.close();
  await expect(openStore(file)).rejects.toMatchObject({
    _tag: "StorageError",
    cause: expect.objectContaining({
      message: expect.stringContaining("Database schema 11 cannot be opened"),
    }),
  });

  const read = new Database(file, { readonly: true });
  expect(read.query("SELECT value FROM sacred").get()).toEqual({ value: "retain" });
  expect(read.query("PRAGMA user_version").get()).toEqual({ user_version: 11 });
  read.close();
});
