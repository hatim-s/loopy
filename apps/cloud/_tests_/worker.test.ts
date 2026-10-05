import { expect, test } from "bun:test";
import { build } from "esbuild";
import { Miniflare, type MiniflareOptions } from "miniflare";
import { prepareRun } from "../../../packages/loopy/src/runtime/prepare.js";
import { sqliteSchema } from "../../../packages/loopy/src/storage/schema.js";
import { SqliteStore } from "../../../packages/loopy/src/storage/sqlite.js";
import cloudWorker from "../src/index.js";
import type { CloudEnv } from "../src/types.js";
import { localClerk } from "./clerk-fixture.js";

async function bundle(path: string) {
  const result = await build({
    entryPoints: [path],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
    external: ["cloudflare:workers", "node:*"],
  });
  const output = result.outputFiles?.[0];
  if (!output) throw new Error("Worker bundle missing");
  return output.text;
}
async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 10_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("Coordinator did not settle");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test("real Worker and Durable Object use Clerk, D1 and runner across alarms, eviction and cancellation", async () => {
  const { config, token } = await localClerk();
  const options: MiniflareOptions = {
    workers: [
      {
        name: "control",
        modules: true,
        script: await bundle(`${import.meta.dir}/fixture-worker.ts`),
        compatibilityDate: "2026-07-30",
        compatibilityFlags: ["nodejs_compat"],
        bindings: { ...config, RUNTIME_BUILD: "integration" },
        d1Databases: { DB: "hosted-do-test" },
        durableObjects: { COORDINATORS: { className: "RunCoordinator", useSQLite: true } },
        serviceBindings: { EXECUTOR: "executor" },
      },
      {
        name: "executor",
        modules: true,
        script: await bundle(`${import.meta.dir}/fixture-executor.ts`),
        compatibilityDate: "2026-07-30",
        compatibilityFlags: ["nodejs_compat"],
        d1Databases: { DB: "hosted-do-test" },
      },
    ],
  };
  const mf = new Miniflare(options);
  try {
    const db = await mf.getD1Database("DB", "control");
    for (const sql of sqliteSchema) await db.prepare(sql).run();
    await db
      .prepare("CREATE TABLE fixture_receipts(id TEXT PRIMARY KEY,revision INTEGER,payload TEXT)")
      .run();
    await db.prepare("CREATE TABLE fixture_jobs(id TEXT PRIMARY KEY,payload TEXT)").run();
    await db
      .prepare(
        "CREATE TABLE fixture_faults(id INTEGER PRIMARY KEY,enabled INTEGER,failures INTEGER,polls INTEGER)",
      )
      .run();
    await db.prepare("INSERT INTO fixture_faults VALUES(1,0,0,0)").run();
    const store = new SqliteStore(db, { tenantId: "user:user_test" });
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
    const artifact = await store.put(new TextEncoder().encode("export default {}"));
    await store.publish({
      id: "version",
      slug: "hello",
      workflow,
      graphHash: snapshot.workflowHash,
      files: [{ path: "main.ts", artifact }],
      entrypoint: "main.ts",
      compiler: "integration",
      runtime: { build: "integration", graphSchema: 1 },
      imageDigest: "sha256:fixture",
    });
    const bearer = await token();
    const call = (path: string, method = "GET", body?: unknown) =>
      mf.dispatchFetch(`https://control.test${path}`, {
        method,
        headers: {
          authorization: `Bearer ${bearer}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    expect((await mf.dispatchFetch("https://control.test/capabilities")).status).toBe(401);
    expect(await (await call("/capabilities")).json()).toMatchObject({
      operations: ["read", "run", "cancel"],
    });
    const create = async (key: string) => {
      const response = await call("/runs", "POST", {
        versionId: "version",
        idempotencyKey: key,
        input: null,
      });
      expect(response.status).toBe(201);
      const result = (await response.json()) as { run: { id: string } };
      return result.run.id;
    };
    const cancelled = await create("cancel-before-start");
    expect((await call(`/runs/${cancelled}/cancel`, "POST")).status).toBe(202);
    expect((await call("/__fixture/cron", "POST")).status).toBe(200);
    await until(async () => (await store.read(cancelled))?.run.status === "interrupted");
    expect(
      (await db.prepare("SELECT count(*) AS n FROM fixture_jobs").first<{ n: number }>())?.n,
    ).toBe(0);

    const running = await create("restart-running");
    await call("/__fixture/cron", "POST");
    await until(async () => !!(await store.read(running))?.intent);
    await until(
      async () =>
        (await db.prepare("SELECT count(*) AS n FROM fixture_jobs").first<{ n: number }>())?.n ===
        1,
    );
    const original = await store.read(running);
    const attemptId = original?.intent?.key.attemptId;
    expect(attemptId).toBeDefined();
    await db.prepare("UPDATE fixture_faults SET enabled=1 WHERE id=1").run();
    // Evict only the real coordinator. D1 receipts and the external provider survive.
    await mf.unsafeEvictDurableObject("control", "RunCoordinator", {
      name: JSON.stringify([store.scope.tenantId, running]),
    });
    await call("/__fixture/cron", "POST");
    await until(
      async () =>
        ((
          await db
            .prepare("SELECT failures FROM fixture_faults WHERE id=1")
            .first<{ failures: number }>()
        )?.failures ?? 0) > 0,
    );
    expect((await store.read(running))?.intent?.key.attemptId).toBe(attemptId);
    await db.prepare("UPDATE fixture_faults SET enabled=0 WHERE id=1").run();
    await call("/__fixture/cron", "POST");
    await db
      .prepare("UPDATE fixture_jobs SET payload=?")
      .bind(JSON.stringify({ state: "unknown", reason: "Fixture provider uncertain" }))
      .run();
    await call("/__fixture/cron", "POST");
    await until(async () => {
      const state = await store.read(running);
      return state?.run.status === "interrupted" && !!state.intent;
    });
    const polls =
      (await db.prepare("SELECT polls FROM fixture_faults WHERE id=1").first<{ polls: number }>())
        ?.polls ?? 0;
    // blocked+wakeAt must rearm the real object while the original intent is unresolved.
    await until(
      async () =>
        ((
          await db.prepare("SELECT polls FROM fixture_faults WHERE id=1").first<{ polls: number }>()
        )?.polls ?? 0) > polls,
    );
    expect((await store.read(running))?.intent?.key.attemptId).toBe(attemptId);
    expect((await call(`/runs/${running}/cancel`, "POST")).status).toBe(202);
    await until(async () => {
      const state = await store.read(running);
      return state?.run.status === "interrupted" && !state.intent;
    });
    expect(
      (await db.prepare("SELECT count(*) AS n FROM fixture_jobs").first<{ n: number }>())?.n,
    ).toBe(1);
    expect((await store.read(running))?.cancelRequested).toBe(true);
    expect((await store.read(running))?.attempts[0]?.id).toBe(attemptId);

    const largeWorkflow = {
      ...workflow,
      nodes: [
        {
          kind: "command" as const,
          id: "first",
          command: { program: "echo", args: ["first"], timeoutMs: 1000, maxOutputBytes: 700_000 },
        },
        {
          kind: "command" as const,
          id: "second",
          command: { program: "echo", args: ["second"], timeoutMs: 1000, maxOutputBytes: 700_000 },
        },
      ],
    };
    const largeSnapshot = await prepareRun(largeWorkflow, null, {
      workspace: { kind: "managed", id: "large" },
      mode: "sandbox",
    });
    await store.publish({
      id: "large-version",
      slug: "hello",
      workflow: largeWorkflow,
      graphHash: largeSnapshot.workflowHash,
      files: [{ path: "main.ts", artifact }],
      entrypoint: "main.ts",
      compiler: "integration",
      runtime: { build: "integration", graphSchema: 1 },
      imageDigest: "sha256:fixture",
    });
    const largeResponse = await call("/runs", "POST", {
      versionId: "large-version",
      idempotencyKey: "large-completion",
      input: null,
    });
    expect(largeResponse.status).toBe(201);
    const largeId = ((await largeResponse.json()) as { run: { id: string } }).run.id;
    await call("/__fixture/cron", "POST");
    for (const nodeId of ["first", "second"]) {
      await until(
        async () =>
          (await store.read(largeId))?.attempts.some(
            (attempt) => attempt.nodeId === nodeId && attempt.status === "running",
          ) ?? false,
      );
      const state = await store.read(largeId);
      if (!state?.intent || state.workspace.state !== "available")
        throw new Error("Missing live completion intent");
      const jobId = JSON.stringify([store.scope.tenantId, largeId, state.intent.key.attemptId]);
      await until(
        async () =>
          !!(await db.prepare("SELECT id FROM fixture_jobs WHERE id=?").bind(jobId).first()),
      );
      // The provider reports a known completion. Observation occurs after the runner deadline.
      await db
        .prepare("UPDATE fixture_jobs SET payload=? WHERE id=?")
        .bind(
          JSON.stringify({
            state: "completed",
            jobId,
            workspace: state.workspace.workspace,
            output: { stdout: "x".repeat(600_000), stderr: "", exitCode: 0, durationMs: 1 },
          }),
          jobId,
        )
        .run();
      await new Promise((resolve) => setTimeout(resolve, 1100));
      await call("/__fixture/cron", "POST");
    }
    await until(async () => (await store.read(largeId))?.run.status === "succeeded");
    const raw = await store.read(largeId);
    expect(new TextEncoder().encode(JSON.stringify(raw)).byteLength).toBeLessThan(512_000);
    const inspected = (await (await call(`/runs/${largeId}`)).json()) as {
      attempts: { output?: { stdout: string } }[];
    };
    expect(inspected.attempts.map((attempt) => attempt.output?.stdout.length)).toEqual([
      600_000, 600_000,
    ]);
    expect(raw?.intent).toBeUndefined();

    // One rejected coordinator must not prevent recovery of a later tenant.
    const createTenantRun = async (tenantId: string) => {
      const scoped = new SqliteStore(db, { tenantId });
      const source = await scoped.put(new TextEncoder().encode("export default {}"));
      await scoped.publish({
        id: "version",
        slug: "hello",
        workflow,
        graphHash: snapshot.workflowHash,
        files: [{ path: "main.ts", artifact: source }],
        entrypoint: "main.ts",
        compiler: "integration",
        runtime: { build: "integration", graphSchema: 1 },
        imageDigest: "sha256:fixture",
      });
      const run = await prepareRun(workflow, null, {
        workspace: { kind: "managed", id: crypto.randomUUID() },
        mode: "sandbox",
      });
      await scoped.admit(
        { versionId: "version", idempotencyKey: "recovery", fingerprint: "fixture", input: null },
        run,
        {
          id: crypto.randomUUID(),
          runId: run.id,
          runtime: { build: "integration", graphSchema: 1 },
        },
      );
      return { scoped, runId: run.id };
    };
    const firstTenant = await createTenantRun("a");
    const lastTenant = await createTenantRun("z");
    const bindings = await mf.getBindings<CloudEnv>("control");
    const rejectedId = bindings.COORDINATORS.idFromName(JSON.stringify(["a", firstTenant.runId]));
    let rejected = 0;
    const failingNamespace = new Proxy(bindings.COORDINATORS, {
      get(target, property) {
        if (property === "get")
          return (id: Parameters<CloudEnv["COORDINATORS"]["get"]>[0]) => {
            if (id.toString() === rejectedId.toString()) {
              rejected++;
              throw new Error("Fixture coordinator unavailable");
            }
            return target.get(id);
          };
        const member = Reflect.get(target, property);
        return typeof member === "function" ? member.bind(target) : member;
      },
    });
    for (let sweep = 0; sweep < 2; sweep++) {
      await expect(
        cloudWorker.scheduled({}, { ...bindings, COORDINATORS: failingNamespace }),
      ).rejects.toThrow("Recovery sweep failed");
      await until(async () => !!(await lastTenant.scoped.read(lastTenant.runId))?.intent);
    }
    expect(rejected).toBeGreaterThanOrEqual(4);
    expect((await firstTenant.scoped.read(firstTenant.runId))?.run.status).toBe("pending");
    expect((await lastTenant.scoped.read(lastTenant.runId))?.attempts.length).toBe(1);
    expect((await firstTenant.scoped.claimDispatch("retry-proof", 1000, 10)).length).toBe(1);
  } finally {
    await mf.dispose();
  }
}, 30_000);
