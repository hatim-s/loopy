import { expect, test } from "bun:test";
import { Miniflare } from "miniflare";
import { sqliteSchema } from "../src/storage/schema.js";
import { SqliteStore } from "../src/storage/sqlite.js";

test("D1 atomic batches, blob identities, conditional writes and dispatch claims", async () => {
  const mf = new Miniflare({
    modules: true,
    script: 'export default {fetch(){return new Response("ok")}}',
    compatibilityDate: "2026-07-30",
    d1Databases: { DB: "local-storage-test" },
  });
  try {
    const db = await mf.getD1Database("DB");
    for (const sql of sqliteSchema) await db.prepare(sql).run();
    const store = new SqliteStore(db, { tenantId: "tenant" });
    const artifact = await store.put(new TextEncoder().encode("source"));
    expect(new TextDecoder().decode(await store.get(artifact))).toBe("source");
    const workflow = { version: 1 as const, slug: "test", nodes: [] };
    const runtime = { build: "build", graphSchema: 1 as const };
    await store.publish({
      id: "v",
      slug: "test",
      workflow,
      graphHash: "hash",
      files: [{ path: "main.ts", artifact }],
      entrypoint: "main.ts",
      compiler: "compiler",
      runtime,
      imageDigest: "image",
    });
    const run = {
      id: "r",
      slug: "test",
      workflow,
      workflowHash: "hash",
      input: null,
      options: { workspace: { kind: "managed" as const, id: "ws" }, mode: "full" as const },
      status: "pending" as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const request = { idempotencyKey: "key", fingerprint: "fp", versionId: "v", input: null };
    const dispatch = { id: "d", runId: "r", runtime };
    expect((await store.admit(request, run, dispatch)).state).toBe("created");
    expect((await store.read("r"))?.workspace).toEqual({ state: "unallocated" });
    const lease = await store.acquire("r", "owner", 10000);
    const state = await store.read("r");
    if (!lease || !state) throw new Error("Missing admitted run");
    expect(
      await store.commit(lease, 0, state, {
        events: [
          { sequence: 1, runId: "r", type: "admitted", data: null, createdAt: run.createdAt },
        ],
        analytics: [{ id: "analytics", data: { type: "admitted" } }],
      }),
    ).toBe(true);
    expect((await store.getEvents("r")).length).toBe(1);
    expect(await store.commit(lease, 0, state, { analytics: [{ id: "stale", data: null }] })).toBe(
      false,
    );
    expect((await store.claimDispatch("delivery", 10000, 10)).length).toBe(1);
    expect(await store.ackDispatch("d", "delivery")).toBe(true);
    // Duplicate analytics identity aborts the complete batch, including the state update.
    const next = await store.read("r");
    if (!next) throw new Error("Missing run");
    await expect(
      store.commit(lease, 1, next, { analytics: [{ id: "analytics", data: null }] }),
    ).rejects.toThrow();
    expect((await store.read("r"))?.revision).toBe(1);
    const analytics = await store.claimAnalytics("analytics-owner", 10000);
    expect(analytics.map((row) => row.id)).toEqual(["analytics"]);
    expect(await store.ackAnalytics("analytics", "wrong-owner")).toBe(false);
    expect(await store.ackAnalytics("analytics", "analytics-owner")).toBe(true);
    expect(await store.pruneAnalytics("2027-01-01T00:00:00Z")).toBe(1);
  } finally {
    await mf.dispose();
  }
}, 30000);
