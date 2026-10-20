import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runSnapshotViewSchema, runViewSchema } from "../src/contract/index.js";
import { type ExecutionResult, type Executor } from "../src/core/index.js";
import { activate, type Clock } from "../src/host/index.js";
import { LoopyService, Registry } from "../src/local/index.js";
import { apiRoutes, dispatch } from "../src/local/server/routes.js";
import { code, finally_, loopy, parallel, sleep, uuid, wait } from "../src/sdk/graph/index.js";
import { MemoryStore, SqliteRunStore } from "../src/store/index.js";
import { FakeExecutor, newRun } from "./fixture.js";

const homes: string[] = [];

const stores: SqliteRunStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) {
    store.close();
  }

  for (const home of homes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "loopy-wait-host-"));
  homes.push(home);
  let now = Date.parse("2026-10-20T00:00:00.000Z");

  const clock: Clock = {
    now: () => now,
    timeout: (fn) => {
      now += 1000;
      queueMicrotask(fn);

      return () => {};
    },
  };

  const file = join(home, "runs.sqlite");
  const store = new SqliteRunStore(file, clock.now);
  stores.push(store);
  const service = new LoopyService({ store, clock, registry: () => new Registry(home, home) });

  const graph = loopy("approval", {
    input: {},
    run: () =>
      wait("approve", {
        timeout: "1s",
        payload: { kind: "record", fields: { approved: "boolean" } },
      }),
  }).graph;

  const registry = new Registry(home, home);
  mkdirSync(dirname(registry.graphPath("a".repeat(64))), { recursive: true });
  writeFileSync(registry.graphPath("a".repeat(64)), JSON.stringify(graph));

  return {
    home,
    clock,
    store,
    service,
    graph,
    file,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

test("approval suspends without executing, named HTTP signal wakes once, and restart continues", async () => {
  const f = fixture();
  await f.store.createRun({ ...newRun(), slug: "approval", input: {}, workspace: f.home });
  const executor = new FakeExecutor();
  expect(await activate({ ...f, executor, runId: "run" })).toEqual({ status: "suspended" });
  expect(executor.calls).toEqual([]);
  expect((await f.store.getRun("run"))?.owner).toBeUndefined();
  expect(await f.store.dueRuns(new Date(f.clock.now()).toISOString())).toHaveLength(0);
  const view = await f.service.view(await f.service.requireRun("run"));
  expect(view.waitingOn?.hook).toBe("approve");

  const table = apiRoutes({
    ...f,
    cwd: f.home,
    daemon: { startedAt: new Date(0).toISOString(), concurrency: 1 },
  });

  const url = new URL("http://localhost/api/runs/run/hooks/approve");

  const send = (approved: boolean | string) =>
    dispatch(
      table,
      new Request(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ payload: { approved } }),
      }),
      url,
    );

  expect((await send("bad")).status).toBe(400);
  const response = await send(true);
  expect(response.status).toBe(200);
  expect(runViewSchema.parse(await response.json()).waitingOn).toBeNull();
  expect((await send(false)).status).toBe(404);
  runSnapshotViewSchema.parse(await f.service.runSnapshot("run"));
  stores.splice(stores.indexOf(f.store), 1);
  f.store.close();
  const reopened = new SqliteRunStore(f.file, f.clock.now);
  stores.push(reopened);
  expect(
    await activate({ store: reopened, clock: f.clock, graph: f.graph, executor, runId: "run" }),
  ).toEqual({ status: "succeeded", output: { approved: true } });
  expect(executor.calls).toEqual([]);
});

test("opaque token HTTP route resolves and timeout rehydration preserves the original deadline", async () => {
  const f = fixture();
  await f.store.createRun({ ...newRun(), input: {}, workspace: f.home });
  const executor = new FakeExecutor();
  await activate({ ...f, executor, runId: "run" });
  const original = (await f.store.getRun("run"))?.wakeAt;
  f.advance(500);
  await activate({ ...f, executor, runId: "run" });
  expect((await f.store.getRun("run"))?.wakeAt).toBe(original);
  const hook = (await f.store.getWaits("run"))[0];

  if (!hook) {
    throw new Error("Missing hook.");
  }

  const table = apiRoutes({
    ...f,
    cwd: f.home,
    daemon: { startedAt: new Date(0).toISOString(), concurrency: 1 },
  });

  const url = new URL(`http://localhost/api/hooks/${hook.token}`);

  const result = await dispatch(
    table,
    new Request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ payload: { approved: false } }),
    }),
    url,
  );

  expect(result.status).toBe(200);
  expect(await activate({ ...f, executor, runId: "run" })).toEqual({
    status: "succeeded",
    output: { approved: false },
  });
});

test("wait deadline fails on resume and sleep resumes once from its persisted deadline", async () => {
  const f = fixture();
  const executor = new FakeExecutor();
  await f.store.createRun({ ...newRun(), input: {} });
  await activate({ ...f, executor, runId: "run" });
  f.advance(1000);
  expect(await activate({ ...f, executor, runId: "run" })).toEqual({
    status: "failed",
    error: "Wait timed out.",
  });
  expect(await f.store.getWaits("run")).toMatchObject([
    { expiredAt: new Date(f.clock.now()).toISOString() },
  ]);

  const graph = loopy("sleeping", {
    input: {},
    run: () => {
      sleep("1s");

      return "awake";
    },
  }).graph;

  await f.store.createRun({ ...newRun(), id: "sleep", input: {} });
  expect(await activate({ ...f, graph, executor, runId: "sleep" })).toEqual({
    status: "suspended",
  });
  const wake = (await f.store.getRun("sleep"))?.wakeAt;
  f.advance(500);
  await activate({ ...f, graph, executor, runId: "sleep" });
  expect((await f.store.getRun("sleep"))?.wakeAt).toBe(wake);
  f.advance(500);
  expect(await activate({ ...f, graph, executor, runId: "sleep" })).toEqual({
    status: "succeeded",
    output: "awake",
  });
  expect(executor.calls).toEqual([]);
});

test("a signal accepted while a parallel execution runs survives its completion", async () => {
  const f = fixture();

  const graph = loopy("both", {
    input: {},
    run: () =>
      parallel({
        approval: () => wait("approve", { payload: { kind: "value", type: "boolean" } }),
        work: () =>
          code("work", { in: {}, out: { kind: "value", type: "number" }, module: "./work.ts" }),
      }),
  }).graph;

  for (const node of graph.nodes) {
    if (node.kind === "code") {
      node.module.bundleHash = "a".repeat(64);
    }
  }

  await f.store.createRun({ ...newRun(), input: {} });

  const executor: Executor = {
    lookup: async () => ({ kind: "none" }),
    execute: async (): Promise<ExecutionResult> => {
      const hook = (await f.store.getWaits("run"))[0];

      if (!hook) {
        throw new Error("Wait was not persisted before dispatch.");
      }

      expect(
        (
          await f.store.resolveWait({
            token: hook.token,
            payload: true,
            at: new Date(f.clock.now()).toISOString(),
          })
        ).kind,
      ).toBe("resolved");

      return { kind: "succeeded", output: 42, logs: [] };
    },
  };

  expect(await activate({ ...f, graph, executor, runId: "run" })).toEqual({
    status: "succeeded",
    output: { approval: true, work: 42 },
  });
});

test("parallel dispatches run concurrently and sampling completes without an executor", async () => {
  const store = new MemoryStore();
  let active = 0;
  let peak = 0;

  const graph = loopy("concurrent", {
    input: {},
    run: () =>
      parallel({
        a: () => code("a", { in: {}, out: { kind: "value", type: "number" }, module: "./a.ts" }),
        b: () => code("b", { in: {}, out: { kind: "value", type: "number" }, module: "./b.ts" }),
        entropy: () => uuid(),
      }),
  }).graph;

  for (const node of graph.nodes) {
    if (node.kind === "code") {
      node.module.bundleHash = "a".repeat(64);
    }
  }

  const executor: Executor = {
    lookup: async () => ({ kind: "none" }),
    execute: async () => {
      active++;
      peak = Math.max(peak, active);
      await Bun.sleep(5);
      active--;

      return { kind: "succeeded", output: 1, logs: [] };
    },
  };

  await store.createRun(newRun());
  expect((await activate({ store, executor, graph, runId: "run" })).status).toBe("succeeded");
  expect(peak).toBe(2);
});

test("cancelling a suspended approval expires its token and cancels its pending node", async () => {
  const f = fixture();
  await f.store.createRun({ ...newRun(), revision: "a".repeat(64), input: {}, workspace: f.home });
  await activate({ ...f, executor: new FakeExecutor(), runId: "run" });
  const wait = (await f.store.getWaits("run"))[0];

  if (!wait) {
    throw new Error("Missing wait.");
  }

  expect((await f.service.cancelRun("run")).status).toBe("cancelled");
  expect(await f.store.getNodeRuns("run")).toMatchObject([{ status: "cancelled" }]);
  expect((await f.store.getWait(wait.token))?.expiredAt).toBeDefined();
  await expect(f.service.resolveHook(wait.token, { approved: true })).rejects.toMatchObject({
    code: "unknown_hook",
  });
});

test("cancellation refuses suspended finally graphs without changing their wait", async () => {
  const f = fixture();

  const graph = loopy("cleanup", {
    input: {},
    run: () =>
      finally_(
        () => wait("approve", { payload: { kind: "value", type: "boolean" } }),
        () => null,
      ),
  }).graph;

  writeFileSync(new Registry(f.home, f.home).graphPath("a".repeat(64)), JSON.stringify(graph));
  await f.store.createRun({ ...newRun(), revision: "a".repeat(64), input: {}, workspace: f.home });
  await activate({ ...f, graph, executor: new FakeExecutor(), runId: "run" });
  const before = await f.store.snapshotRun("run");
  await expect(f.service.cancelRun("run")).rejects.toMatchObject({
    code: "not_claimable",
    message:
      "This run requires finally cleanup. Cancellation with cleanup is not available; resume the run instead.",
  });
  expect(await f.store.snapshotRun("run")).toEqual(before);
});

test("an indefinite signal advances its branch before a long sibling completes", async () => {
  const f = fixture();

  const graph = loopy("prompt", {
    input: {},
    run: () =>
      parallel({
        approval: () => {
          const decision = wait("approve", { payload: { kind: "value", type: "boolean" } });

          return code("after", {
            in: { decision },
            out: { kind: "value", type: "number" },
            module: "./after.ts",
          });
        },
        long: () =>
          code("long", { in: {}, out: { kind: "value", type: "number" }, module: "./long.ts" }),
      }),
  }).graph;

  for (const node of graph.nodes) {
    if (node.kind === "code") {
      node.module.bundleHash = node.label === "long" ? "b".repeat(64) : "a".repeat(64);
    }
  }

  await f.store.createRun({ ...newRun(), input: {} });
  const gate = new AbortController();

  const executor: Executor = {
    lookup: async () => ({ kind: "none" }),
    execute: async (...args) => {
      const [, , spec, signal] = args;

      if (spec.kind !== "code") {
        throw new Error("Expected code.");
      }

      if (spec.bundleHash === "a".repeat(64)) {
        expect(spec.input).toEqual({ decision: true });
        gate.abort();

        return { kind: "succeeded", output: 1, logs: [] };
      }

      const hook = (await f.store.getWaits("run"))[0];

      if (!hook) {
        throw new Error("Missing hook.");
      }

      await f.store.resolveWait({
        token: hook.token,
        payload: true,
        at: new Date(f.clock.now()).toISOString(),
      });

      if (!gate.signal.aborted) {
        await new Promise<void>((resolve) => {
          gate.signal.addEventListener("abort", () => resolve(), { once: true });
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      }

      return { kind: "succeeded", output: 2, logs: [] };
    },
  };

  expect(await activate({ ...f, graph, executor, runId: "run" })).toEqual({
    status: "succeeded",
    output: { approval: 1, long: 2 },
  });
}, 1000);
