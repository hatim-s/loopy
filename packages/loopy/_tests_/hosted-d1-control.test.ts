import { expect, test } from "bun:test";
import { Miniflare } from "miniflare";
import type { WorkflowVersion } from "../src/application/ports.js";
import { createControlHandler } from "../src/cloud/api.js";
import { type ControlTransport, HostedControlClient } from "../src/cloud/client.js";
import { HostedControl, type VerifiedPrincipal } from "../src/cloud/control.js";
import { type DurableDriver, dispatchPending } from "../src/cloud/dispatch.js";
import { prepareRun } from "../src/runtime/prepare.js";
import { sqliteSchema } from "../src/storage/schema.js";
import { SqliteStore } from "../src/storage/sqlite.js";

const runtime = { build: "integration", graphSchema: 1 } as const;
const alice: VerifiedPrincipal = {
  subject: "alice",
  tenantId: "org-a",
  operations: ["read", "run", "cancel"],
};
const bob: VerifiedPrincipal = {
  subject: "bob",
  tenantId: "org-b",
  operations: ["read", "run", "cancel"],
};

test("HTTP control uses real D1 atomic admission, tenant isolation and fenced cancellation recovery", async () => {
  const mf = new Miniflare({
    modules: true,
    script: 'export default {fetch(){return new Response("ok")}}',
    compatibilityDate: "2026-07-30",
    d1Databases: { DB: "hosted-control-test" },
  });
  try {
    const db = await mf.getD1Database("DB");
    for (const sql of sqliteSchema) await db.prepare(sql).run();
    let now = Date.now();
    const a = new SqliteStore(db, { tenantId: alice.tenantId }, {}, () => new Date(now));
    const b = new SqliteStore(db, { tenantId: bob.tenantId }, {}, () => new Date(now));
    const workflow = {
      version: 1 as const,
      slug: "hello",
      nodes: [
        { kind: "command" as const, id: "hello", command: { program: "echo", args: ["hello"] } },
      ],
    };
    const snapshot = await prepareRun(workflow, null, {
      workspace: { kind: "managed", id: "ws" },
      mode: "sandbox",
    });
    for (const store of [a, b]) {
      const artifact = await store.put(new TextEncoder().encode("export default {}"));
      const version: WorkflowVersion = {
        id: "version",
        slug: "hello",
        workflow,
        graphHash: snapshot.workflowHash,
        files: [{ path: "main.ts", artifact }],
        entrypoint: "main.ts",
        compiler: "integration",
        runtime,
        imageDigest: "sha256:integration",
      };
      await store.publish(version);
    }
    let online = false;
    let starts = 0;
    const driver: DurableDriver = {
      ensureStarted: async (scope, runId) => {
        if (!online) throw new Error("offline");
        const state = await (scope.tenantId === alice.tenantId ? a : b).read(runId);
        if (state && !state.cancelRequested) starts++;
      },
      cancel: async () => {
        if (!online) throw new Error("offline");
      },
    };
    const control = new HostedControl(
      ({ tenantId }) => {
        const store = tenantId === alice.tenantId ? a : b;
        return { catalog: store, admission: store, runs: store };
      },
      driver,
      { protocol: 1, runtime, operations: ["read", "run", "cancel"], executors: ["integration"] },
    );
    const handler = createControlHandler(control, async (request) =>
      request.headers.get("authorization") === "Bearer alice"
        ? alice
        : request.headers.get("authorization") === "Bearer bob"
          ? bob
          : undefined,
    );
    const transport: ControlTransport = (input, init) => handler(new Request(input, init));
    const client = new HostedControlClient("https://control.test", async () => "alice", transport);
    const other = new HostedControlClient("https://control.test", async () => "bob", transport);
    const request = { versionId: "version", idempotencyKey: "same-key", input: { b: 2, a: 1 } };
    const admitted = await client.admit(request);
    if (admitted.state === "conflict") throw new Error("Unexpected conflict");
    const runId = admitted.run.id;
    expect((await client.inspect(runId)).run.id).toBe(runId);
    expect(await client.admit({ ...request, input: { a: 1, b: 2 } })).toMatchObject({
      state: "existing",
      run: { id: runId },
    });
    await expect(client.admit({ ...request, input: null })).rejects.toMatchObject({ status: 409 });
    await expect(other.inspect(runId)).rejects.toMatchObject({ status: 404 });
    await expect(other.cancel(runId)).rejects.toMatchObject({ status: 404 });
    expect((await other.admit(request)).state).toBe("created");

    const oldLease = await a.acquire(runId, "old-owner", 10);
    const oldState = await a.read(runId);
    if (!oldLease || !oldState) throw new Error("Missing lease/state");
    const oldDispatch = await a.claimDispatch("old-delivery", 10, 100);
    expect(oldDispatch.length).toBe(1);
    await db
      .prepare(
        "CREATE TRIGGER fail_cancel BEFORE INSERT ON loopy_outbox WHEN json_extract(NEW.payload,'$.kind')='cancel' BEGIN SELECT RAISE(ABORT,'test cancellation failure'); END",
      )
      .run();
    await expect(client.cancel(runId)).rejects.toMatchObject({ status: 503 });
    expect((await a.read(runId))?.cancelRequested).toBe(false);
    expect((await a.read(runId))?.revision).toBe(0);
    await db.prepare("DROP TRIGGER fail_cancel").run();
    await client.cancel(runId);
    await client.cancel(runId);
    expect((await a.read(runId))?.cancelRequested).toBe(true);
    expect((await a.read(runId))?.revision).toBe(1);
    // Cancellation invalidates the snapshot revision independently of lease fencing.
    expect(await a.commit(oldLease, oldState.revision, oldState)).toBe(false);
    const current = await a.read(runId);
    if (!current) throw new Error("Missing current cancelled state");
    expect(current.revision).toBe(1);
    const cancelIntent = await a.claimDispatch("cancel-delivery", 10, 100);
    expect(cancelIntent.map((item) => item.kind)).toEqual(["cancel"]);
    now += 11;
    expect(await a.ackDispatch(admitted.dispatch.id, "old-delivery")).toBe(false);
    expect(await a.retryDispatch(admitted.dispatch.id, "old-delivery", "stale")).toBe(false);
    // Current revision reaches the lease SQL, so these checks prove expiry and replacement fencing.
    expect(await a.commit(oldLease, current.revision, current)).toBe(false);
    const replacement = await a.acquire(runId, "replacement", 1000);
    if (!replacement) throw new Error("Missing replacement lease");
    expect(replacement.fence).toBe(2);
    expect(await a.commit(oldLease, current.revision, current)).toBe(false);
    expect(await a.commit(replacement, current.revision, current)).toBe(true);
    expect((await a.read(runId))?.revision).toBe(2);
    const recovered = await a.claimDispatch("recovery", 1000, 100);
    expect(recovered.map((item) => item.kind).sort()).toEqual(["cancel", "start"]);
    for (const row of recovered)
      expect(await a.retryDispatch(row.id, row.leaseToken, "retry")).toBe(true);
    online = true;
    expect(await dispatchPending(a, driver)).toEqual({ delivered: 2, retried: 0, stale: 0 });
    // This injected driver models a cancellation-aware host, not a deployed coordinator.
    expect(starts).toBe(0);
    expect(await a.claimDispatch("nothing-left", 1000, 100)).toEqual([]);
    expect((await b.claimDispatch("bob-delivery", 1000, 100)).length).toBe(1);
  } finally {
    await mf.dispose();
  }
}, 30_000);
