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
    expect(await store.runtimeForRun("r")).toEqual(runtime);
    expect(await store.runtimeForRun("missing")).toBeUndefined();
    expect(await SqliteStore.recoveryTenants(db)).toEqual({ tenantIds: ["tenant"] });
    expect((await store.recoveryRuns()).runs).toEqual([{ runId: "r", runtime }]);
    const completed = { ...next, run: { ...next.run, status: "succeeded" as const } };
    expect(await store.commit(lease, 1, completed)).toBe(true);
    expect((await store.recoveryRuns()).runs).toEqual([]);
    expect(await SqliteStore.recoveryTenants(db)).toEqual({ tenantIds: [] });
    const outstanding = {
      ...completed,
      revision: 2,
      run: { ...completed.run, status: "interrupted" as const },
      intent: {
        key: { tenantId: "tenant", runId: "r", attemptId: "a" },
        fingerprint: "fp",
        command: { program: "tool", args: [] },
        workspace: { workspaceId: "ws", generation: "g" },
        deadline: "2026-10-05T00:00:00Z",
      },
    };
    expect(await store.commit(lease, 2, outstanding)).toBe(true);
    expect((await store.recoveryRuns()).runs).toEqual([{ runId: "r", runtime }]);
    const other = new SqliteStore(db, { tenantId: "z-tenant" });
    expect(await other.runtimeForRun("r")).toBeUndefined();
    expect((await other.recoveryRuns()).runs).toEqual([]);
    const version = await store.getVersion("v");
    if (!version) throw new Error("Missing version");
    await other.put(new TextEncoder().encode("source"));
    await other.publish({ ...version, runtime: { ...runtime, build: "new-build" } });
    await other.admit(request, run, { ...dispatch, runtime: { ...runtime, build: "new-build" } });
    expect(await other.runtimeForRun("r")).toEqual({ ...runtime, build: "new-build" });
    expect(await store.runtimeForRun("r")).toEqual(runtime);
    const page = await SqliteStore.recoveryTenants(db, undefined, 1);
    expect(page).toEqual({ tenantIds: ["tenant"], cursor: "tenant" });
    expect(await SqliteStore.recoveryTenants(db, page.cursor, 1)).toEqual({
      tenantIds: ["z-tenant"],
    });
    await store.admit(
      { ...request, idempotencyKey: "key-2" },
      { ...run, id: "r2" },
      { ...dispatch, id: "d2", runId: "r2" },
    );
    const runPage = await store.recoveryRuns(undefined, 1);
    expect(runPage).toEqual({ runs: [{ runId: "r", runtime }], cursor: "r" });
    expect(await store.recoveryRuns(runPage.cursor, 1)).toEqual({
      runs: [{ runId: "r2", runtime }],
    });
    const oversizedJson = new TextEncoder().encode(
      JSON.stringify({ stdout: "\u0000".repeat(1048576), stderr: "", exitCode: 0, durationMs: 1 }),
    );
    const largeArtifact = await store.put(oversizedJson);
    expect(largeArtifact.bytes).toBeGreaterThan(6000000);
    expect(await store.get(largeArtifact)).toEqual(oversizedJson);
    const chunkLimit = await db
      .prepare("SELECT MAX(length(content)) AS max FROM loopy_artifact_chunks")
      .first<{ max: number }>();
    expect(chunkLimit?.max).toBe(262144);
  } finally {
    await mf.dispose();
  }
}, 30000);
