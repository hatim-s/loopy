import { expect, test } from "bun:test";
import { Miniflare } from "miniflare";
import { HostedControl } from "../src/cloud/control.js";
import {
  type ExecutionReceipt,
  type LinuxExecutionProvider,
  RemoteLinuxExecutor,
} from "../src/cloud/executor/controller.js";
import type { Json, Workflow } from "../src/core/model.js";
import { hydrateAttempts } from "../src/runtime/attempt-artifacts.js";
import { DurableRunner } from "../src/runtime/durable-runner.js";
import { prepareRun } from "../src/runtime/prepare.js";
import type { ExecutionObservation, StartCommand } from "../src/runtime/remote-executor.js";
import {
  executionReceiptSchema,
  SqliteExecutionReceiptStore,
} from "../src/storage/execution-receipts.js";
import { sqliteSchema } from "../src/storage/schema.js";
import { SqliteStore } from "../src/storage/sqlite.js";

async function fixture(workflow: Workflow, input: Json = {}) {
  const mf = new Miniflare({
    modules: true,
    script: 'export default {fetch(){return new Response("ok")}}',
    compatibilityDate: "2026-07-30",
    d1Databases: { DB: "runner" },
  });
  const db = await mf.getD1Database("DB");
  for (const sql of sqliteSchema) await db.prepare(sql).run();
  let clock = Date.now();
  const store = new SqliteStore(db, { tenantId: "tenant" }, {}, () => new Date(clock));
  const runtime = { build: "v1", graphSchema: 1 as const };
  const run = await prepareRun(workflow, input, {
    mode: "sandbox",
    workspace: { kind: "managed", id: "ws" },
  });
  await store.publish({
    id: "version",
    slug: workflow.slug,
    workflow,
    graphHash: run.workflowHash,
    files: [{ path: "main.ts", artifact: await store.put(new TextEncoder().encode("source")) }],
    entrypoint: "main.ts",
    compiler: "compiler",
    runtime,
    imageDigest: "image",
  });
  await store.admit(
    { versionId: "version", input, idempotencyKey: "key", fingerprint: "fp" },
    run,
    { id: "dispatch", runId: run.id, runtime },
  );
  const receipts = new Map<string, ExecutionReceipt>();
  const receiptStore = {
    async read(key: { attemptId: string }) {
      const value = receipts.get(key.attemptId);
      return value && structuredClone(value);
    },
    async compareAndSwap(
      key: { attemptId: string },
      revision: number | undefined,
      next: ExecutionReceipt,
    ) {
      if (receipts.get(key.attemptId)?.revision !== revision) return false;
      receipts.set(key.attemptId, structuredClone(next));
      return true;
    },
  };
  const make = (provider: LinuxExecutionProvider) =>
    new DurableRunner({
      store,
      artifacts: store,
      artifactBytes: store.limits.artifactBytes,
      executor: new RemoteLinuxExecutor(receiptStore, provider, () => clock),
      runtime,
      runtimeForRun: (runId) => store.runtimeForRun(runId),
      now: () => clock,
      stateBytes: store.limits.stateBytes,
      workspaces: {
        async provision(_, __, workspaceId) {
          return { workspaceId, generation: "g1" };
        },
        async inspect(_, workspace) {
          return await provider.workspace(workspace);
        },
      },
    });
  return {
    mf,
    db,
    store,
    run,
    make,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}
const command = (id: string, timeoutMs = 10000) => ({
  id,
  kind: "command" as const,
  command: { program: "echo", args: [], timeoutMs },
});

async function prepare(f: Awaited<ReturnType<typeof fixture>>, runner: DurableRunner) {
  await runner.tick(f.run.id);
  await runner.tick(f.run.id);
}

test("real D1 and executor retain launch intent across overlapping unknown tick and later cancel", async () => {
  const f = await fixture({ version: 1, slug: "overlap", nodes: [command("one")] });
  let release!: () => void;
  let accepted!: () => void;
  const started = new Promise<void>((resolve) => {
    accepted = resolve;
  });
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  let launches = 0;
  let cancels = 0;
  let request!: StartCommand;
  const provider: LinuxExecutionProvider = {
    async workspace() {
      return "available";
    },
    async start(value) {
      launches++;
      request = value;
      accepted();
      await hold;
      return { state: "running", jobId: "job", workspace: value.workspace };
    },
    async inspect() {
      return { state: "unknown", reason: "Start acknowledgement pending" };
    },
    async cancel() {
      cancels++;
      return {
        state: "completed",
        jobId: "job",
        workspace: request.workspace,
        output: { stdout: "", stderr: "cancelled", durationMs: 1, exitCode: 130 },
      };
    },
  };
  try {
    const runner = f.make(provider);
    await prepare(f, runner);
    const launch = runner.tick(f.run.id);
    await started;
    await runner.tick(f.run.id);
    const unknown = await f.store.read(f.run.id);
    expect(unknown?.run.status).toBe("interrupted");
    expect(unknown?.intent).toBeDefined();
    await f.store.requestCancel(f.run.id);
    await runner.tick(f.run.id);
    expect(cancels).toBeGreaterThan(0);
    release();
    await launch;
    await runner.tick(f.run.id);
    expect(launches).toBe(1);
  } finally {
    release?.();
    await f.mf.dispose();
  }
}, 30000);

test("real D1 stores accumulated 600k outputs outside state and hydrates branch expressions", async () => {
  const nodes: Workflow["nodes"] = [
    command("one"),
    command("two"),
    {
      id: "choice",
      kind: "condition",
      test: {
        $op: "contains",
        args: [{ $ref: { source: "steps", path: ["one", "stdout"] } }, "z"],
      },
      // biome-ignore lint/suspicious/noThenProperty: Workflow branch field.
      then: [
        {
          id: "yes",
          kind: "command",
          command: {
            program: "echo",
            args: [{ $ref: { source: "steps", path: ["one", "stdout"] } }],
          },
        },
      ],
      else: [
        {
          id: "no",
          kind: "command",
          command: { program: "echo", args: [{ $ref: { source: "input", path: ["missing"] } }] },
        },
      ],
    },
  ];
  const f = await fixture({ version: 1, slug: "large", nodes });
  let launches = 0;
  const jobs = new Map<string, ExecutionObservation>();
  const provider: LinuxExecutionProvider = {
    async workspace() {
      return "available";
    },
    async start(request) {
      launches++;
      const result = {
        state: "completed" as const,
        jobId: request.key.attemptId,
        workspace: request.workspace,
        output: { stdout: "z".repeat(600000), stderr: "", exitCode: 0, durationMs: 1 },
      };
      jobs.set(request.key.attemptId, result);
      return result;
    },
    async inspect(key) {
      return jobs.get(key.attemptId) ?? { state: "not-started" };
    },
    async cancel() {
      return { state: "unknown", reason: "Unexpected cancel" };
    },
  };
  try {
    const runner = f.make(provider);
    for (let step = 0; step < 20; step++) {
      await runner.tick(f.run.id);
      if ((await f.store.read(f.run.id))?.run.status === "succeeded") break;
    }
    const state = await f.store.read(f.run.id);
    expect(state?.run.status).toBe("succeeded");
    expect(new TextEncoder().encode(JSON.stringify(state)).length).toBeLessThan(512000);
    const attempts = await hydrateAttempts(state?.attempts ?? [], f.store);
    expect((attempts[0]?.output as { stdout: string }).stdout.length).toBe(600000);
    expect(attempts.find((attempt) => attempt.nodeId === "choice")?.output).toEqual({
      branch: "then",
    });
    expect(
      (attempts.find((attempt) => attempt.nodeId === "yes")?.input as { args: string[] }).args[0]
        ?.length,
    ).toBe(600000);
    const control = new HostedControl(
      () => ({ catalog: f.store, admission: f.store, runs: f.store, artifacts: f.store }),
      { async ensureStarted() {}, async cancel() {} },
      {
        protocol: 1,
        runtime: { build: "v1", graphSchema: 1 },
        operations: ["read"],
        executors: ["controlled"],
      },
    );
    const inspected = await control.inspect(
      { subject: "user", tenantId: "tenant", operations: ["read"] },
      f.run.id,
    );
    expect((inspected.attempts[0]?.output as { stdout: string }).stdout.length).toBe(600000);
    expect(launches).toBe(3);
  } finally {
    await f.mf.dispose();
  }
}, 30000);

test("authoritative completed receipt succeeds when coordinator polls after deadline", async () => {
  const f = await fixture({ version: 1, slug: "late", nodes: [command("one", 10)] });
  let observation: ExecutionObservation = { state: "not-started" };
  let request!: StartCommand;
  const provider: LinuxExecutionProvider = {
    async workspace() {
      return "available";
    },
    async start(value) {
      request = value;
      observation = { state: "running", jobId: "job", workspace: value.workspace };
      return observation;
    },
    async inspect() {
      return observation;
    },
    async cancel() {
      return { state: "unknown", reason: "Cancel should not replace completed result" };
    },
  };
  try {
    const runner = f.make(provider);
    await prepare(f, runner);
    await runner.tick(f.run.id);
    observation = {
      state: "completed",
      jobId: "job",
      workspace: request.workspace,
      output: { stdout: "ok", stderr: "", exitCode: 0, durationMs: 1 },
    };
    f.advance(1000);
    await runner.tick(f.run.id);
    await runner.tick(f.run.id);
    expect((await f.store.read(f.run.id))?.run.status).toBe("succeeded");
  } finally {
    await f.mf.dispose();
  }
}, 30000);

test("storage boundary rollback removes new intent and stops recovery without orphan cancellation", async () => {
  const f = await fixture(
    {
      version: 1,
      slug: "boundary",
      nodes: Array.from({ length: 35 }, (_, index) => command(`step${index}`)),
    },
    "x".repeat(502000),
  );
  let launches = 0;
  let cancels = 0;
  const observations = new Map<string, ExecutionObservation>();
  const provider: LinuxExecutionProvider = {
    async workspace() {
      return "available";
    },
    async start(request) {
      launches++;
      const result = {
        state: "completed" as const,
        jobId: request.key.attemptId,
        workspace: request.workspace,
        output: { stdout: "z".repeat(600000), stderr: "", exitCode: 0, durationMs: 1 },
      };
      observations.set(request.key.attemptId, result);
      return result;
    },
    async inspect(key) {
      return observations.get(key.attemptId) ?? { state: "not-started" };
    },
    async cancel() {
      cancels++;
      return { state: "unknown", reason: "Orphan intent" };
    },
  };
  try {
    const runner = f.make(provider);
    for (let tick = 0; tick < 60; tick++) {
      await runner.tick(f.run.id);
      if ((await f.store.read(f.run.id))?.run.status === "interrupted") break;
    }
    const state = await f.store.read(f.run.id);
    expect(state?.run.status).toBe("interrupted");
    expect(state?.run.error).toContain("storage limit");
    expect(state?.intent).toBeUndefined();
    expect(state?.attempts.length).toBe(launches);
    expect((await f.store.recoveryRuns()).runs).toEqual([]);
    await f.store.requestCancel(f.run.id);
    f.advance(300001);
    expect((await runner.tick(f.run.id)).state).toBe("terminal");
    expect((await f.store.recoveryRuns()).runs).toEqual([]);
    expect(cancels).toBe(0);
    expect(
      new TextEncoder().encode(JSON.stringify(await f.store.read(f.run.id))).length,
    ).toBeLessThan(512000);
  } finally {
    await f.mf.dispose();
  }
}, 60000);

test("real runner and D1 receipt capacity reject two MiB before intent and accept one MiB", async () => {
  const f = await fixture({ version: 1, slug: "capacity", nodes: [command("one")] });
  for (const sql of executionReceiptSchema) await f.db.prepare(sql).run();
  let launches = 0;
  const provider: LinuxExecutionProvider = {
    async workspace() {
      return "available";
    },
    async start(request) {
      launches++;
      return {
        state: "completed",
        jobId: "job",
        workspace: request.workspace,
        output: { stdout: "z".repeat(1_048_576), stderr: "", exitCode: 0, durationMs: 1 },
      };
    },
    async inspect() {
      return { state: "not-started" };
    },
    async cancel() {
      return { state: "cancelled-before-start" };
    },
  };
  const executor = new RemoteLinuxExecutor(
    new SqliteExecutionReceiptStore(f.db, f.store.scope),
    provider,
  );
  const make = (maxOutputBytes: number) =>
    new DurableRunner({
      store: f.store,
      artifacts: f.store,
      artifactBytes: f.store.limits.artifactBytes,
      stateBytes: f.store.limits.stateBytes,
      executor,
      runtime: { build: "v1", graphSchema: 1 },
      runtimeForRun: (runId) => f.store.runtimeForRun(runId),
      maxOutputBytes,
      workspaces: {
        async provision(_, __, workspaceId) {
          return { workspaceId, generation: "g1" };
        },
        async inspect() {
          return "available";
        },
      },
    });
  try {
    expect(executor.maxOutputBytes).toBe(1_048_576);
    expect(() => make(2_097_152)).toThrow("capacity");
    const rejected = await f.store.read(f.run.id);
    expect(rejected?.revision).toBe(0);
    expect(rejected?.attempts).toEqual([]);
    expect(rejected?.intent).toBeUndefined();
    expect(launches).toBe(0);
    expect(
      await f.db
        .prepare("SELECT COUNT(*) AS count FROM loopy_execution_receipts")
        .first<{ count: number }>(),
    ).toEqual({ count: 0 });
    const runner = make(1_048_576);
    for (let tick = 0; tick < 8; tick++) {
      await runner.tick(f.run.id);
      if ((await f.store.read(f.run.id))?.run.status === "succeeded") break;
    }
    const accepted = await f.store.read(f.run.id);
    expect(accepted?.run.status).toBe("succeeded");
    expect(accepted?.intent).toBeUndefined();
    expect(launches).toBe(1);
    const hydrated = await hydrateAttempts(accepted?.attempts ?? [], f.store);
    expect((hydrated[0]?.output as { stdout: string }).stdout.length).toBe(1_048_576);
  } finally {
    await f.mf.dispose();
  }
}, 30000);
