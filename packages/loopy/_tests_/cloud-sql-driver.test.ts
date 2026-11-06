import { afterEach, expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { nodeIdSchema } from "../src/contract";
import type { Store, StoreEffect } from "../src/core";
import { EVENT_RETENTION, MemoryStore } from "../src/store";
import {
  type SqlDriver,
  SqlRunStore,
  type SqlStatement,
  type SqlStoreOptions,
  type SqlTransactionMode,
  type SqlValue,
} from "../src/store/portable";
import { BunSqlDriver } from "../src/store/sqlite/bun-driver";
import { applyQuerySchema } from "../src/store/sqlite/query/schema";
import { SCHEMA, WAIT_SCHEMA } from "../src/store/sqlite/store-schema";
import { newRun } from "./fixture";
import { storeContract } from "./store-contract";

const drivers: BunSqlDriver[] = [];

const at = newRun().createdAt;

const owner = { identity: { pid: null, host: "workspace:test:session" }, isAlive: () => false };

afterEach(() => {
  for (const driver of drivers.splice(0)) {
    driver.close();
  }
});

// Real SQLite executes every statement. This adapter rejects local-only setup SQL.
class PortableDriver implements SqlDriver {
  constructor(readonly sqlite: BunSqlDriver) {}

  private check(sql: string): void {
    if (/\b(?:PRAGMA|ALTER|DROP)\b/i.test(sql)) {
      throw new Error("Portable store requested local schema setup.");
    }
  }

  query<Row = Record<string, SqlValue>, Params extends SqlValue[] = SqlValue[]>(
    sql: string,
  ): SqlStatement<Row, Params> {
    this.check(sql);

    return this.sqlite.query<Row, Params>(sql);
  }

  exec(sql: string): void {
    this.check(sql);
    this.sqlite.exec(sql);
  }

  transaction<T>(callback: () => T, mode: SqlTransactionMode): T {
    return this.sqlite.transaction(callback, mode);
  }
}

function fixture(options: Omit<SqlStoreOptions, "owner"> = {}) {
  const sqlite = new BunSqlDriver(":memory:");
  drivers.push(sqlite);
  const driver = new PortableDriver(sqlite);
  const store = new SqlRunStore(driver, { owner, ...options });

  return { sqlite, driver, store };
}

storeContract("portable SQL with lease-only ownership", (options) => fixture(options).store);

test("portable entry bundles for browsers without Bun or Node dependencies", async () => {
  const result = await Bun.build({
    entrypoints: [new URL("../src/store/portable.ts", import.meta.url).pathname],
    target: "browser",
  });

  expect(result.success).toBe(true);
  expect(result.logs).toEqual([]);
});

test("portable schema reopens with its epoch, records and cursor intact", async () => {
  const { store, driver, sqlite } = fixture();
  await Effect.runPromise(store.createRun(newRun()));
  const cursor = await Effect.runPromise(store.eventCursor());
  const reopened = new SqlRunStore(driver, { owner });
  expect(await Effect.runPromise(reopened.eventCursor())).toEqual(cursor);
  expect(await Effect.runPromise(reopened.getRun("run"))).toEqual(newRun());
  expect(sqlite.query("PRAGMA user_version").get()).toEqual({ user_version: 0 });
  expect(sqlite.query("SELECT value FROM meta WHERE key='schema_version'").get()).toEqual({
    value: "15",
  });
});

for (const mode of ["immediate", "deferred"] as const) {
  test(`${mode} SQL transactions return results and roll back writes on SQLite failure`, () => {
    const { driver } = fixture();
    driver.exec("CREATE TABLE driver_values (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");

    const insert = driver.query<{ id: number; value: string }, [number, string]>(
      "INSERT INTO driver_values VALUES (?,?) RETURNING *",
    );

    expect(driver.transaction(() => insert.get(1, "first"), mode)).toEqual({
      id: 1,
      value: "first",
    });
    expect(() =>
      driver.transaction(() => {
        insert.run(2, "rolled back");
        insert.run(1, "duplicate");
      }, mode),
    ).toThrow("UNIQUE constraint failed");
    expect(driver.query("SELECT * FROM driver_values").all()).toEqual([{ id: 1, value: "first" }]);
    expect(driver.query("DELETE FROM driver_values WHERE id=?").run(1).changes).toBe(1);
    expect(driver.query("SELECT * FROM driver_values").get()).toBeNull();
  });
}

test("failed fresh initialization rolls back DDL and preserves preexisting views", () => {
  const sqlite = new BunSqlDriver(":memory:");
  drivers.push(sqlite);
  sqlite.exec("CREATE VIEW logs AS SELECT 1 AS saved");
  const driver = new PortableDriver(sqlite);
  expect(() => new SqlRunStore(driver, { owner })).toThrow("already exists");
  expect(sqlite.query("SELECT saved FROM logs").get()).toEqual({ saved: 1 });
  expect(
    sqlite
      .query("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all(),
  ).toEqual([]);
  sqlite.exec("DROP VIEW logs");
  expect(new SqlRunStore(driver, { owner })).toBeInstanceOf(SqlRunStore);
});

test("unsupported portable databases retain their records", () => {
  const sqlite = new BunSqlDriver(":memory:");
  drivers.push(sqlite);
  sqlite.exec("CREATE TABLE personal (value TEXT); INSERT INTO personal VALUES ('retained')");
  expect(() => new SqlRunStore(new PortableDriver(sqlite), { owner })).toThrow(
    "SQL store schema unknown cannot be opened",
  );
  expect(sqlite.query("SELECT * FROM personal").all()).toEqual([{ value: "retained" }]);
});

for (const version of [13, 14]) {
  test(`fresh schema matches the migrated schema ${version} tables and indexes`, () => {
    const fresh = fixture().sqlite;
    const legacy = new BunSqlDriver(":memory:");
    drivers.push(legacy);
    legacy.exec(version === 13 ? SCHEMA.replace(WAIT_SCHEMA, "") : SCHEMA);

    if (version === 13) {
      legacy.exec(WAIT_SCHEMA);
    }

    applyQuerySchema(legacy);
    legacy.exec(
      "CREATE INDEX schedules_enabled_next ON schedules(enabled,next_fire_at,workspace,slug)",
    );

    const tables = fresh
      .query<{ name: string }, []>("SELECT name FROM sqlite_schema WHERE type='table'")
      .all();

    for (const { name } of tables) {
      expect(fresh.query(`PRAGMA table_info('${name}')`).all()).toEqual(
        legacy.query(`PRAGMA table_info('${name}')`).all(),
      );
      expect(fresh.query(`PRAGMA foreign_key_list('${name}')`).all()).toEqual(
        legacy.query(`PRAGMA foreign_key_list('${name}')`).all(),
      );

      const indexes = (db: BunSqlDriver) =>
        db
          .query<{ name: string }, []>(`PRAGMA index_list('${name}')`)
          .all()
          .map((row) => ({
            name: row.name,
            columns: db.query(`PRAGMA index_info('${row.name}')`).all(),
          }))
          .sort((a, b) => a.name.localeCompare(b.name));

      expect(indexes(fresh)).toEqual(indexes(legacy));
    }
  });
}

function logEffects(count: number): StoreEffect[] {
  return [...Array(count).keys()].map((index) => ({
    kind: "write_log",
    executionKey: {
      runId: "run",
      nodeId: Schema.decodeUnknownSync(nodeIdSchema)("0:code"),
      scope: [],
    },
    attempt: 1,
    at,
    log: { message: `line ${index}`, data: null },
  }));
}

for (const kind of ["portable", "memory"] as const) {
  test(`${kind} age pruning removes a full transaction when time crosses the cutoff mid-batch`, async () => {
    let tick = Date.parse(at);
    const now = () => tick++;
    const store: Store = kind === "portable" ? fixture({ now }).store : new MemoryStore(now);
    await Effect.runPromise(store.createRun(newRun()));
    await Effect.runPromise(store.claim("run", "owner"));
    await Effect.runPromise(store.apply({ runId: "run", token: "owner", effects: logEffects(2) }));
    const events = await Effect.runPromise(store.events(0, 10));
    const tail = events.at(-1);

    if (!tail) {
      throw new Error("Missing transaction tail.");
    }

    expect(events[2]?.txn).toBe(tail.txn);
    const pruneAt = new Date(Date.parse(tail.at) + EVENT_RETENTION.maxAgeMs).toISOString();
    expect(await Effect.runPromise(store.pruneEvents(pruneAt))).toBe(4);
    expect(await Effect.runPromise(store.events(0, 10))).toEqual([]);
    expect(await Effect.runPromise(store.eventCursor())).toMatchObject({ cursor: 4 });
    await Effect.runPromise(store.heartbeat("run", "owner"));
    expect((await Effect.runPromise(store.events(0, 10)))[0]?.sequence).toBe(5);
  });
}

test("row retention removes an entire transaction prefix and keeps replay boundaries", async () => {
  const { store, sqlite } = fixture({ now: () => Date.parse(at) });
  await Effect.runPromise(store.createRun(newRun()));
  await Effect.runPromise(store.claim("run", "owner"));
  await Effect.runPromise(store.apply({ runId: "run", token: "owner", effects: logEffects(2) }));
  const batch = (await Effect.runPromise(store.events(2, 10)))[0];

  if (!batch) {
    throw new Error("Missing batch event.");
  }

  // Fill the durable outbox directly so the boundary falls between batch rows 3 and 4.
  sqlite
    .query(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<99999)
    INSERT INTO events(at,txn,entity,kind,run_id,record)
    SELECT ?,CAST(x AS TEXT),entity,kind,run_id,record FROM n JOIN events ON sequence=1`)
    .run(at);
  sqlite.query("UPDATE events SET at=? WHERE sequence=1").run("2026-10-14T00:00:00.000Z");
  expect(await Effect.runPromise(store.pruneEvents(at))).toBe(4);
  expect(await Effect.runPromise(store.oldestEventSequence())).toBe(5);
  expect(await Effect.runPromise(store.transactionEvents(batch.txn, 0))).toEqual([]);
  expect((await Effect.runPromise(store.events(4, 1)))[0]?.sequence).toBe(5);
  expect(await Effect.runPromise(store.eventCursor())).toMatchObject({ cursor: 100003 });
});

test("portable initialization ignores Cloudflare internal tables and retains nullable owner identity", async () => {
  const sqlite = new BunSqlDriver(":memory:");
  drivers.push(sqlite);
  sqlite.exec(
    "CREATE TABLE __cf_kv (key TEXT PRIMARY KEY, value BLOB); CREATE TABLE _cf_metadata (value TEXT)",
  );
  sqlite.query("INSERT INTO __cf_kv VALUES ('saved','retained')").run();
  const driver = new PortableDriver(sqlite);
  let now = Date.parse(at);
  const store = new SqlRunStore(driver, { owner, now: () => now, leaseMs: 1000 });
  await Effect.runPromise(store.createRun(newRun()));
  expect(await Effect.runPromise(store.claim("run", "first"))).toMatchObject({
    owner: { token: "first", pid: null, host: owner.identity.host },
  });
  expect((await Effect.runPromise(store.events(0, 10))).at(-1)).toMatchObject({
    record: { owner: { pid: null } },
  });
  now += 1000;
  await expect(Effect.runPromise(store.claim("run", "second"))).rejects.toThrow("not owned");
  now++;
  expect(await Effect.runPromise(store.claim("run", "second"))).toMatchObject({
    owner: { token: "second", pid: null },
  });
  expect(await Effect.runPromise(store.heartbeat("run", "first"))).toBe(false);
  expect(sqlite.query("SELECT value FROM __cf_kv WHERE key='saved'").get()).toEqual({
    value: "retained",
  });
});

test("memory row retention keeps the stricter cap when an older event also expires", async () => {
  let now = Date.parse(at) - 1;
  const store = new MemoryStore(() => now);
  await Effect.runPromise(store.createRun(newRun()));
  now++;
  await Effect.runPromise(store.claim("run", "owner"));
  await Effect.runPromise(store.apply({ runId: "run", token: "owner", effects: logEffects(2) }));

  for (let index = 0; index < 99_999; index++) {
    await Effect.runPromise(store.heartbeat("run", "owner"));
  }

  const pruneAt = new Date(now + EVENT_RETENTION.maxAgeMs).toISOString();
  expect(await Effect.runPromise(store.pruneEvents(pruneAt))).toBe(4);
  expect(await Effect.runPromise(store.oldestEventSequence())).toBe(5);
});
