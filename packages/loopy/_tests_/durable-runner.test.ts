import { expect, test } from "bun:test";
import type { CommandOutput, Workflow } from "../src/core/model.js";
import { DurableRunner } from "../src/runtime/durable-runner.js";
import { prepareRun } from "../src/runtime/prepare.js";
import type {
  ExecutionObservation,
  RemoteExecutor,
  StartCommand,
} from "../src/runtime/remote-executor.js";
import type {
  DurableRunRepository,
  DurableRunState,
  TransitionLease,
} from "../src/runtime/transition-store.js";

async function fixture(
  nodes: Workflow["nodes"] = [
    { id: "one", kind: "command", command: { program: "echo", args: [] } },
  ],
) {
  const runtime = { build: "v1", graphSchema: 1 as const };
  const run = await prepareRun(
    { version: 1, slug: "runner", nodes },
    {},
    { mode: "sandbox", workspace: { kind: "managed", id: "workspace" } },
  );
  let state: DurableRunState = {
    revision: 0,
    run,
    attempts: [],
    workspace: { state: "unallocated" },
    cancelRequested: false,
  };
  let held: TransitionLease | undefined;
  let fence = 0;
  let rejectCommit = false;
  let available = true;
  let launches = 0;
  let lostAck = false;
  const jobs = new Map<string, ExecutionObservation>();
  let request: StartCommand | undefined;
  const output: CommandOutput = { stdout: "ok", stderr: "", exitCode: 0, durationMs: 2 };
  const store: DurableRunRepository = {
    scope: { tenantId: "tenant" },
    async read() {
      return structuredClone(state);
    },
    async acquire(runId, token) {
      if (held) return;
      held = {
        runId,
        token,
        fence: ++fence,
        expiresAt: new Date(Date.now() + 10_000).toISOString(),
      };
      return held;
    },
    async commit(lease, revision, next) {
      if (rejectCommit || lease.token !== held?.token || revision !== state.revision) return false;
      state = structuredClone({ ...next, revision: revision + 1 });
      return true;
    },
    async release(lease) {
      if (held?.token === lease.token) held = undefined;
    },
    async requestCancel() {
      state.cancelRequested = true;
      state.revision++;
    },
  };
  const executor: RemoteExecutor = {
    maxOutputBytes: 1_048_576,
    async inspect(key) {
      expect(held).toBeUndefined();
      return jobs.get(key.attemptId) ?? { state: "not-started" };
    },
    async start(value) {
      expect(held).toBeUndefined();
      request = value;
      launches++;
      const observed = { state: "running" as const, jobId: "job", workspace: value.workspace };
      jobs.set(value.key.attemptId, observed);
      if (lostAck) throw new Error("Lost acknowledgement");
      return observed;
    },
    async cancel(key) {
      expect(held).toBeUndefined();
      const observed = { state: "cancelled-before-start" as const };
      jobs.set(key.attemptId, observed);
      return observed;
    },
  };
  const artifacts = new Map<string, Uint8Array>();
  const artifactStore = {
    scope: store.scope,
    async put(bytes: Uint8Array) {
      const id = crypto.randomUUID();
      artifacts.set(id, bytes);
      return { id, sha256: id, bytes: bytes.length };
    },
    async get(identity: { id: string }) {
      return artifacts.get(identity.id);
    },
  };
  const make = (
    build = "v1",
    maxOutputBytes?: number,
    artifactBytes = 8_000_000,
    executorCapacity = 1_048_576,
  ) =>
    new DurableRunner({
      store,
      executor: { ...executor, maxOutputBytes: executorCapacity },
      artifacts: artifactStore,
      artifactBytes,
      maxOutputBytes,
      runtime: { ...runtime, build },
      runtimeForRun: async () => runtime,
      workspaces: {
        async provision(_, __, workspaceId) {
          expect(held).toBeUndefined();
          return { workspaceId, generation: "g1" };
        },
        async inspect() {
          expect(held).toBeUndefined();
          return available ? "available" : "lost";
        },
      },
    });
  return {
    run,
    store,
    make,
    state: () => state,
    launches: () => launches,
    loseAck: () => {
      lostAck = true;
    },
    loseWorkspace: () => {
      available = false;
    },
    reject: () => {
      rejectCommit = true;
    },
    unknown: () => {
      if (!request) throw new Error("Not launched");
      jobs.set(request.key.attemptId, { state: "unknown", reason: "Provider lost its receipt" });
    },
    complete: () => {
      if (!request) throw new Error("Not launched");
      jobs.set(request.key.attemptId, {
        state: "completed",
        jobId: "job",
        workspace: request.workspace,
        output,
      });
    },
  };
}

async function intent(f: Awaited<ReturnType<typeof fixture>>) {
  await f.make().tick(f.run.id);
  await f.make().tick(f.run.id);
  expect(f.state().intent).toBeDefined();
}

test("lost acknowledgement and coordinator restart inspect the same running job", async () => {
  const f = await fixture();
  await intent(f);
  const attemptId = f.state().intent?.key.attemptId;
  f.loseAck();
  await expect(f.make().tick(f.run.id)).rejects.toThrow("Lost acknowledgement");
  expect((await f.make().tick(f.run.id)).state).toBe("waiting");
  expect(f.state().intent?.key.attemptId).toBe(attemptId);
  expect(f.launches()).toBe(1);
  f.complete();
  await f.make().tick(f.run.id);
  await f.make().tick(f.run.id);
  expect(f.state().run.status).toBe("succeeded");
  await f.make().tick(f.run.id);
  expect(f.launches()).toBe(1);
});

test("cancel persisted before launch creates no command effect", async () => {
  const f = await fixture();
  await intent(f);
  await f.store.requestCancel(f.run.id);
  await f.make().tick(f.run.id);
  expect(f.launches()).toBe(0);
  expect(f.state().attempts[0]?.status).toBe("cancelled");
  expect(f.state().run.status).toBe("interrupted");
});

test("workspace loss blocks after a successful file-producing checkpoint", async () => {
  const f = await fixture([
    { id: "one", kind: "command", command: { program: "touch", args: ["file"] } },
    { id: "two", kind: "command", command: { program: "cat", args: ["file"] } },
  ]);
  await intent(f);
  await f.make().tick(f.run.id);
  f.complete();
  await f.make().tick(f.run.id);
  f.loseWorkspace();
  await f.make().tick(f.run.id);
  expect(f.state().workspace.state).toBe("lost");
  expect(f.state().run.status).toBe("interrupted");
  expect(f.launches()).toBe(1);
});

test("failed fenced commit cannot launch an unpersisted intent", async () => {
  const f = await fixture();
  await f.make().tick(f.run.id);
  f.reject();
  await f.make().tick(f.run.id);
  await f.make().tick(f.run.id);
  expect(f.state().intent).toBeUndefined();
  expect(f.launches()).toBe(0);
});

test("a deployment with another runtime build cannot advance the pinned run", async () => {
  const f = await fixture();
  expect((await f.make("v2").tick(f.run.id)).state).toBe("blocked");
  expect(f.state().revision).toBe(0);
});

test("unknown remote effects block duplicate delivery without replay", async () => {
  const f = await fixture();
  await intent(f);
  await f.make().tick(f.run.id);
  f.unknown();
  await f.make().tick(f.run.id);
  expect(f.state().attempts[0]?.status).toBe("uncertain");
  expect(f.state().run.status).toBe("interrupted");
  await f.make().tick(f.run.id);
  expect(f.launches()).toBe(1);
});

test("unsupported output configuration rejects before persisting intent or launching", async () => {
  const f = await fixture();
  expect(() => f.make("v1", 2_097_152)).toThrow("capacity");
  expect(() => f.make("v1", 1_048_576, 1_000_000)).toThrow("capacity");
  expect(() => f.make("v1", 1_048_576, 8_000_000, 65_536)).toThrow("capacity");
  expect(f.state().intent).toBeUndefined();
  expect(f.state().attempts).toEqual([]);
  expect(f.launches()).toBe(0);
});
test("workflow output cap beyond selected capacity fails before persisting intent", async () => {
  const f = await fixture([
    {
      id: "one",
      kind: "command",
      command: { program: "echo", args: [], maxOutputBytes: 2_097_152 },
    },
  ]);
  await f.make().tick(f.run.id);
  await f.make().tick(f.run.id);
  expect(f.state().run.status).toBe("failed");
  expect(f.state().intent).toBeUndefined();
  expect(f.state().attempts).toEqual([]);
  expect(f.launches()).toBe(0);
});
