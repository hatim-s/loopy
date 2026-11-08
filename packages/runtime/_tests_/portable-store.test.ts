import { expect, test } from "bun:test";
import { nodeIdSchema } from "@loopy/contract";
import type { StoreEffect } from "@loopy/core";
import { Effect, Schema } from "effect";
import { newRun } from "../../core/_tests_/fixtures/run";
import { BunSqlDriver } from "../src/store/bun-driver";
import { EVENT_RETENTION } from "../src/store/event-outbox";
import {
  type SqlDriver,
  SqlRunStore,
  type SqlStatement,
  type SqlStoreOptions,
  type SqlTransactionMode,
  type SqlValue,
} from "../src/store/portable";
import { storeContract } from "./fixtures/store-contract";
import { runAt } from "./fixtures/stores";
import { onCleanup } from "./fixtures/test-scope";

const at = newRun().createdAt;

const run = runAt(() => Date.parse(at));

const owner = { identity: { pid: null, host: "workspace:test:session" }, isAlive: () => false };

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
  onCleanup(() => sqlite.close());
  const driver = new PortableDriver(sqlite);
  const store = new SqlRunStore(driver, { owner, ...options });

  return { sqlite, driver, store };
}

storeContract("portable SQL with lease-only ownership", (options) => fixture(options).store);

test("portable schema reopens with its epoch, records and cursor intact", async () => {
  const { store, driver, sqlite } = fixture();
  await Effect.runPromise(store.createRun(newRun()));
  const cursor = await Effect.runPromise(store.eventCursor());
  const reopened = new SqlRunStore(driver, { owner });
  expect(await Effect.runPromise(reopened.eventCursor())).toEqual(cursor);
  expect(await Effect.runPromise(reopened.getRun("run"))).toEqual(newRun());
  expect(sqlite.query("PRAGMA user_version").get()).toEqual({ user_version: 0 });
  expect(sqlite.query("SELECT value FROM meta WHERE key='schema_version'").get()).toEqual({
    value: "16",
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
  onCleanup(() => sqlite.close());
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
  onCleanup(() => sqlite.close());
  sqlite.exec("CREATE TABLE personal (value TEXT); INSERT INTO personal VALUES ('retained')");
  expect(() => new SqlRunStore(new PortableDriver(sqlite), { owner })).toThrow(
    "SQL store schema unknown cannot be opened",
  );
  expect(sqlite.query("SELECT * FROM personal").all()).toEqual([{ value: "retained" }]);
});

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

test("age pruning removes a whole transaction when the cutoff falls inside it", async () => {
  const { store, sqlite } = fixture();
  await run(store.createRun(newRun()));
  await run(store.claim("run", "owner"));
  await run(store.apply({ runId: "run", token: "owner", effects: logEffects(2) }));
  const events = await run(store.events(0, 10));
  const tail = events.at(-1);

  if (!tail) {
    throw new Error("Missing transaction tail.");
  }

  expect(events[2]?.txn).toBe(tail.txn);
  // Age the first row of the batch so the cutoff splits the transaction.
  sqlite.query("UPDATE events SET at=? WHERE sequence<=3").run("2026-10-15T00:00:00.000Z");
  const pruneAt = new Date(Date.parse(tail.at) + EVENT_RETENTION.maxAgeMs).toISOString();
  expect(await run(store.pruneEvents(pruneAt))).toBe(4);
  expect(await run(store.events(0, 10))).toEqual([]);
  expect(await run(store.eventCursor())).toMatchObject({ cursor: 4 });
  await run(store.heartbeat("run", "owner"));
  expect((await run(store.events(0, 10)))[0]?.sequence).toBe(5);
});

test("row retention removes an entire transaction prefix and keeps replay boundaries", async () => {
  const { store, sqlite } = fixture();
  await run(store.createRun(newRun()));
  await run(store.claim("run", "owner"));
  await run(store.apply({ runId: "run", token: "owner", effects: logEffects(2) }));
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
  onCleanup(() => sqlite.close());
  sqlite.exec(
    "CREATE TABLE __cf_kv (key TEXT PRIMARY KEY, value BLOB); CREATE TABLE _cf_metadata (value TEXT)",
  );
  sqlite.query("INSERT INTO __cf_kv VALUES ('saved','retained')").run();
  const driver = new PortableDriver(sqlite);
  let now = Date.parse(at);
  const runNow = runAt(() => now);
  const store = new SqlRunStore(driver, { owner, leaseMs: 1000 });
  await runNow(store.createRun(newRun()));
  expect(await runNow(store.claim("run", "first"))).toMatchObject({
    owner: { token: "first", pid: null, host: owner.identity.host },
  });
  expect((await Effect.runPromise(store.events(0, 10))).at(-1)).toMatchObject({
    record: { owner: { pid: null } },
  });
  now += 1000;
  await expect(runNow(store.claim("run", "second"))).rejects.toThrow("not owned");
  now++;
  expect(await runNow(store.claim("run", "second"))).toMatchObject({
    owner: { token: "second", pid: null },
  });
  expect(await runNow(store.heartbeat("run", "first"))).toBe(false);
  expect(sqlite.query("SELECT value FROM __cf_kv WHERE key='saved'").get()).toEqual({
    value: "retained",
  });
});
