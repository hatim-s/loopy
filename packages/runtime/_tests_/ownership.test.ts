import { expect, test } from "bun:test";
import { InMemoryRuntimeStore } from "../../testing/src/index.ts";
import { type ProviderExecutor, type RuntimePlan, RuntimeScheduler } from "../src/index.ts";

const plan = (nodes: RuntimePlan["nodes"]): RuntimePlan => ({
  workflowId: "audit",
  workflowVersion: 1,
  nodes,
  edges: [],
  policies: { concurrency: { maxParallel: 4 } },
  topology: { startNodeIds: nodes.map((n) => n.id), terminalNodeIds: nodes.map((n) => n.id) },
});
async function until(check: () => boolean) {
  for (let i = 0; i < 100 && !check(); i++) await Bun.sleep(2);
  expect(check()).toBe(true);
}

test("failed branch drains an abort-ignoring sibling and publishes the original failure once", async () => {
  let release: (() => void) | undefined;
  let failed: (() => void) | undefined;
  let aborted = false;
  const provider: ProviderExecutor = {
    execute: async ({ nodeId, signal }) => {
      if (nodeId === "fail") {
        await new Promise<void>((r) => {
          failed = r;
        });
        return { status: "failed", error: "original failure" };
      }
      signal.addEventListener("abort", () => {
        aborted = true;
      });
      await new Promise<void>((r) => {
        release = r;
      });
      return { status: "succeeded" };
    },
  };
  const runtime = new RuntimeScheduler({ store: new InMemoryRuntimeStore(), provider });
  const run = await runtime.start(
    plan([
      { id: "fail", kind: "agent" },
      { id: "sibling", kind: "agent" },
    ]),
  );
  await until(() => Boolean(release && failed));
  failed?.();
  await until(() => aborted);
  await Bun.sleep(70);
  expect((await runtime.snapshot(run.runId)).run.status).toBe("cancelling");
  release?.();
  const done = await runtime.wait(run.runId);
  expect(done.run).toMatchObject({ status: "failed", error: "original failure" });
  expect(done.attempts.every((a) => a.status !== "running")).toBe(true);
  expect(done.events.filter((e) => e.type === "run.completed")).toHaveLength(1);
});

test("retry deadline survives sibling pump, pause and resume", async () => {
  const calls: number[] = [];
  const runtime = new RuntimeScheduler({
    store: new InMemoryRuntimeStore(),
    provider: {
      execute: async ({ nodeId }) => {
        if (nodeId === "other") {
          await Bun.sleep(20);
          return { status: "succeeded" };
        }
        calls.push(Date.now());
        return calls.length === 1 ? { status: "failed" } : { status: "succeeded" };
      },
    },
  });
  const run = await runtime.start(
    plan([
      { id: "retry", kind: "agent", retry: { maxAttempts: 2, backoffMs: 120 } },
      { id: "other", kind: "agent" },
    ]),
  );
  await until(() => calls.length === 1);
  await runtime.pause(run.runId);
  await Bun.sleep(35);
  await runtime.resume(run.runId);
  await Bun.sleep(30);
  expect(calls).toHaveLength(1);
  expect((await runtime.wait(run.runId)).run.status).toBe("succeeded");
  expect((calls[1] ?? 0) - (calls[0] ?? 0)).toBeGreaterThanOrEqual(115);
});

test("skipped node retry rejects without persisting a new attempt", async () => {
  const store = new InMemoryRuntimeStore();
  const runtime = new RuntimeScheduler({
    store,
    provider: { execute: async () => ({ status: "failed" }) },
  });
  const runId = "skipped-run";
  const runPlan = plan([{ id: "a", kind: "agent" }]);
  await store.commit([
    {
      type: "create_run",
      run: {
        runId,
        workflowId: "audit",
        workflowVersion: 1,
        plan: runPlan,
        inputs: {},
        status: "failed",
        createdAt: new Date().toISOString(),
      },
    },
    {
      type: "create_attempt",
      attempt: {
        attemptId: "skip",
        runId,
        nodeId: "a",
        attempt: 1,
        status: "skipped",
        input: {},
        createdAt: new Date().toISOString(),
      },
    },
  ]);
  await expect(runtime.retry(runId, "a")).rejects.toThrow("Only a failed or cancelled");
  expect(await store.listAttempts(runId)).toHaveLength(1);
});

test("shutdown drains cancelling work without changing its terminal intent", async () => {
  let release: (() => void) | undefined;
  const runtime = new RuntimeScheduler({
    store: new InMemoryRuntimeStore(),
    provider: {
      execute: async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return { status: "succeeded" };
      },
    },
  });
  const run = await runtime.start(plan([{ id: "a", kind: "agent" }]));
  await until(() => Boolean(release));
  expect((await runtime.cancel(run.runId)).status).toBe("cancelling");
  const stopping = runtime.shutdown();
  release?.();
  await stopping;
  expect((await runtime.snapshot(run.runId)).run.status).toBe("cancelled");
});

test("retrying the failed branch does not report success while its required sibling remains cancelled", async () => {
  let release: (() => void) | undefined;
  let fail: (() => void) | undefined;
  let retried = false;
  const runtime = new RuntimeScheduler({
    store: new InMemoryRuntimeStore(),
    provider: {
      execute: async ({ nodeId }) => {
        if (nodeId === "a") {
          if (retried) return { status: "succeeded" };
          await new Promise<void>((resolve) => {
            fail = resolve;
          });
          return { status: "failed" };
        }
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return { status: "succeeded" };
      },
    },
  });
  const run = await runtime.start(
    plan([
      { id: "a", kind: "agent" },
      { id: "b", kind: "agent" },
    ]),
  );
  await until(() => Boolean(fail && release));
  fail?.();
  await Bun.sleep(70);
  release?.();
  expect((await runtime.wait(run.runId)).run.status).toBe("failed");
  retried = true;
  await runtime.retry(run.runId, "a");
  expect((await runtime.wait(run.runId)).run.status).toBe("failed");
});
