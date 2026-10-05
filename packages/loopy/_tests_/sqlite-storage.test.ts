import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import type { DurableRunState } from "../src/runtime/transition-store.js";
import { sqliteSchema } from "../src/storage/schema.js";
import { SqliteStore } from "../src/storage/sqlite.js";
import type { SqliteDatabase, SqliteStatement, SqlValue } from "../src/storage/sqlite-driver.js";

function database() {
  const raw = new Database(":memory:");
  raw.exec("PRAGMA foreign_keys=ON");
  for (const sql of sqliteSchema) raw.exec(sql);
  class Statement implements SqliteStatement {
    values: SqlValue[] = [];
    constructor(readonly query: string) {}
    bind(...values: SqlValue[]) {
      this.values = values;
      return this;
    }
    async first<T>() {
      return raw
        .query(this.query)
        .get(
          ...this.values.map((value) =>
            value instanceof ArrayBuffer ? new Uint8Array(value) : value,
          ),
        ) as T | null;
    }
    async all<T>() {
      return {
        results: raw
          .query(this.query)
          .all(
            ...this.values.map((value) =>
              value instanceof ArrayBuffer ? new Uint8Array(value) : value,
            ),
          ) as T[],
        meta: {},
      };
    }
    async run() {
      const result = raw
        .query(this.query)
        .run(
          ...this.values.map((value) =>
            value instanceof ArrayBuffer ? new Uint8Array(value) : value,
          ),
        );
      return { meta: { changes: result.changes } };
    }
  }
  const db: SqliteDatabase = {
    prepare: (sql) => new Statement(sql),
    async batch(statements) {
      return raw.transaction(() =>
        statements.map((s) => {
          const stmt = s as Statement;
          const result = raw
            .query(stmt.query)
            .run(
              ...stmt.values.map((value) =>
                value instanceof ArrayBuffer ? new Uint8Array(value) : value,
              ),
            );
          return { meta: { changes: result.changes } };
        }),
      )();
    },
  };
  return { db, raw };
}
async function fixture() {
  const { db, raw } = database();
  let clock = new Date("2026-10-05T00:00:00Z");
  const store = new SqliteStore(db, { tenantId: "one" }, {}, () => clock);
  const artifact = await store.put(new TextEncoder().encode("source"));
  const workflow = { version: 1 as const, slug: "demo", nodes: [] };
  const version = {
    id: "v1",
    slug: "demo",
    workflow,
    graphHash: "hash",
    files: [{ path: "main.ts", artifact }],
    entrypoint: "main.ts",
    compiler: "v1",
    runtime: { build: "v1", graphSchema: 1 as const },
    imageDigest: "image",
  };
  await store.publish(version);
  const run = {
    id: "r1",
    slug: "demo",
    workflow,
    workflowHash: "hash",
    input: null,
    options: { workspace: { kind: "managed" as const, id: "ws" }, mode: "full" as const },
    status: "pending" as const,
    createdAt: clock.toISOString(),
    updatedAt: clock.toISOString(),
  };
  const request = { idempotencyKey: "key", fingerprint: "fp", versionId: "v1", input: null };
  const dispatch = { id: "d1", runId: run.id, runtime: version.runtime };
  return {
    store,
    db,
    raw,
    artifact,
    version,
    run,
    request,
    dispatch,
    advance: () => {
      clock = new Date(clock.getTime() + 1001);
    },
  };
}
test("admission is idempotent, conflicts and rolls back its run when outbox fails", async () => {
  const f = await fixture();
  expect((await f.store.admit(f.request, f.run, f.dispatch)).state).toBe("created");
  expect(
    (
      await f.store.admit(
        f.request,
        { ...f.run, id: "r2" },
        { ...f.dispatch, id: "d2", runId: "r2" },
      )
    ).state,
  ).toBe("existing");
  expect(
    (await f.store.admit({ ...f.request, fingerprint: "other" }, f.run, f.dispatch)).state,
  ).toBe("conflict");
  f.raw.exec(
    "CREATE TRIGGER reject_outbox BEFORE INSERT ON loopy_outbox BEGIN SELECT RAISE(ABORT,'failed'); END",
  );
  await expect(
    f.store.admit(
      { ...f.request, idempotencyKey: "new" },
      { ...f.run, id: "r3" },
      { ...f.dispatch, id: "d3", runId: "r3" },
    ),
  ).rejects.toThrow("failed");
  expect(f.raw.query("SELECT count(*) AS n FROM loopy_runs").get()).toEqual({ n: 1 });
});
test("immutable tenant versions and artifact limits", async () => {
  const f = await fixture();
  const other = new SqliteStore(f.db, { tenantId: "two" });
  expect(await other.get(f.artifact)).toBeUndefined();
  expect(await other.getVersion("v1")).toBeUndefined();
  await expect(f.store.publish({ ...f.version, imageDigest: "changed" })).rejects.toThrow(
    "Immutable",
  );
  await expect(
    new SqliteStore(f.db, { tenantId: "one" }, { artifactBytes: 1 }).put(new Uint8Array(2)),
  ).rejects.toThrow("limit");
});
test("lease expiry, reclaim fencing, cancellation revision prevent stale commits", async () => {
  const f = await fixture();
  await f.store.admit(f.request, f.run, f.dispatch);
  const lease = await f.store.acquire("r1", "owner", 1000);
  if (!lease) throw new Error("Missing lease");
  const state: DurableRunState = {
    revision: 0,
    run: f.run,
    attempts: [],
    workspace: { state: "available", workspace: { workspaceId: "ws", generation: "g1" } },
    cancelRequested: false,
  };
  expect(await f.store.commit(lease, 0, state)).toBe(true);
  expect(await f.store.acquire("r1", "other", 1000)).toBeUndefined();
  f.advance();
  expect(await f.store.commit(lease, 1, { ...state, revision: 1 })).toBe(false);
  const next = await f.store.acquire("r1", "other", 1000);
  if (!next) throw new Error("Missing lease");
  expect(next.fence).toBe(2);
  await f.store.release(lease);
  expect(await f.store.acquire("r1", "third", 1000)).toBeUndefined();
  await f.store.requestCancel("r1");
  expect(await f.store.commit(next, 1, { ...state, revision: 1 })).toBe(false);
  expect((await f.store.read("r1"))?.cancelRequested).toBe(true);
});

test("dispatch leases fence acknowledgement after expiry and isolate tenants", async () => {
  const f = await fixture();
  await f.store.admit(f.request, f.run, f.dispatch);
  expect(await new SqliteStore(f.db, { tenantId: "two" }).claimDispatch("other", 1000, 10)).toEqual(
    [],
  );
  expect((await f.store.claimDispatch("first", 1000, 10)).length).toBe(1);
  expect(await f.store.claimDispatch("second", 1000, 10)).toEqual([]);
  f.advance();
  expect(await f.store.ackDispatch("d1", "first")).toBe(false);
  expect((await f.store.claimDispatch("second", 1000, 10)).length).toBe(1);
  expect(await f.store.retryDispatch("d1", "first", "failed")).toBe(false);
  expect(await f.store.ackDispatch("d1", "second")).toBe(true);
  expect(await f.store.claimDispatch("third", 1000, 10)).toEqual([]);
});

test("cancellation queues once and run/analytics transitions roll back together", async () => {
  const f = await fixture();
  await f.store.admit(f.request, f.run, f.dispatch);
  expect((await f.store.read("r1"))?.workspace).toEqual({ state: "unallocated" });
  await f.store.requestCancel("r1");
  await f.store.requestCancel("r1");
  const deliveries = await f.store.claimDispatch("delivery", 1000, 10);
  expect(deliveries.filter((row) => row.kind === "cancel").length).toBe(1);
  const lease = await f.store.acquire("r1", "owner", 1000);
  const state = await f.store.read("r1");
  if (!lease || !state) throw new Error("Missing run");
  const records = {
    events: [{ sequence: 1, runId: "r1", type: "cancel", data: null, createdAt: f.run.createdAt }],
    analytics: [{ id: "a1", data: null }],
  };
  expect(await f.store.commit(lease, 1, state, records)).toBe(true);
  const next = await f.store.read("r1");
  if (!next) throw new Error("Missing run");
  await expect(f.store.commit(lease, 2, next, records)).rejects.toThrow();
  expect((await f.store.read("r1"))?.revision).toBe(2);
  expect((await f.store.getEvents("r1")).length).toBe(1);
  expect(await f.store.pruneEvents("2027-01-01T00:00:00Z", 1)).toBe(1);
});

test("artifact put snapshots caller bytes before hashing yields", async () => {
  const { db } = database();
  const store = new SqliteStore(db, { tenantId: "tenant" });
  const bytes = new TextEncoder().encode("original");
  const pending = store.put(bytes);
  bytes.fill(0);
  const identity = await pending;
  expect(new TextDecoder().decode(await store.get(identity))).toBe("original");
  expect(identity.sha256).toBe(
    await Bun.CryptoHasher.hash("sha256", new TextEncoder().encode("original"), "hex"),
  );
});

test("publication bundles belong to the tenant and metadata survives immutable readback", async () => {
  const f = await fixture();
  const foreign = new SqliteStore(f.db, { tenantId: "foreign" });
  const foreignBundle = await foreign.put(new TextEncoder().encode("foreign bundle"));
  const publication = {
    bundle: foreignBundle,
    lockfileHash: "lock-hash",
    sourceMappings: [{ source: "main.ts", target: "bundle.js" }],
  };
  await expect(f.store.publish({ ...f.version, id: "published", publication })).rejects.toThrow(
    "Missing publication",
  );
  const absent = { id: "missing", sha256: "missing", bytes: 1 };
  await expect(
    f.store.publish({
      ...f.version,
      id: "published",
      publication: { ...publication, bundle: absent },
    }),
  ).rejects.toThrow("Missing publication");
  const bundle = await f.store.put(new TextEncoder().encode("tenant bundle"));
  const version = { ...f.version, id: "published", publication: { ...publication, bundle } };
  expect(await f.store.publish(version)).toEqual(version);
  expect(await f.store.getVersion("published")).toEqual(version);
  await expect(
    f.store.publish({
      ...version,
      publication: { ...version.publication, lockfileHash: "changed" },
    }),
  ).rejects.toThrow("Immutable version");
});

test("chunk failure rolls back metadata and earlier chunks", async () => {
  const { db, raw } = database();
  const store = new SqliteStore(db, { tenantId: "tenant" });
  raw.exec(
    "CREATE TRIGGER reject_second_chunk BEFORE INSERT ON loopy_artifact_chunks WHEN NEW.part=1 BEGIN SELECT RAISE(ABORT,'chunk failed'); END",
  );
  await expect(store.put(new Uint8Array(300000))).rejects.toThrow("chunk failed");
  expect(raw.query("SELECT count(*) AS n FROM loopy_artifacts").get()).toEqual({ n: 0 });
  expect(raw.query("SELECT count(*) AS n FROM loopy_artifact_chunks").get()).toEqual({ n: 0 });
});

test("admission reserves terminal state budget before writing a run or dispatch", async () => {
  const f = await fixture();
  const store = new SqliteStore(f.db, { tenantId: "one" }, { stateBytes: 10000 });
  const input = "x".repeat(6000);
  await expect(
    store.admit({ ...f.request, input }, { ...f.run, input }, f.dispatch),
  ).rejects.toThrow("Storage payload");
  expect(f.raw.query("SELECT count(*) AS n FROM loopy_runs").get()).toEqual({ n: 0 });
  expect(f.raw.query("SELECT count(*) AS n FROM loopy_outbox").get()).toEqual({ n: 0 });
});
