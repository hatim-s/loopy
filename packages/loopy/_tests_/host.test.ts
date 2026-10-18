import { expect, test } from "bun:test";
import type { Executor } from "../src/core/index.js";
import { initialState, step } from "../src/engine/index.js";
import { activate, type Clock } from "../src/host/index.js";
import { code, loopy, sh } from "../src/sdk/graph/index.js";
import { SqliteRunStore } from "../src/store/index.js";
import { newRun } from "./fixture.js";

function graph() {
  const graph = loopy("test", {
    input: {},
    run: () =>
      code("work", { in: {}, out: { kind: "value", type: "number" }, module: "./work.ts" }),
  }).graph;

  const node = graph.nodes[0];

  if (node?.kind !== "code") {
    throw new Error("Expected code node.");
  }

  node.module.bundleHash = "a".repeat(64);

  return graph;
}

test.each(["none", "finished"] as const)(
  "host resumes the same persisted attempt from a %s receipt",
  async (kind) => {
    const store = new SqliteRunStore(":memory:");
    const plan = graph();
    await store.createRun(newRun());
    await store.claim("run", "old");

    const started = step(plan, initialState("run", {}), {
      kind: "resume",
      at: newRun().createdAt,
    });

    const node = started.state.nodeRuns[0];

    if (!node) {
      throw new Error("Expected running node.");
    }

    await store.apply({
      runId: "run",
      token: "old",
      effects: [{ kind: "write_node_run", nodeRun: { ...node, attempt: 2 } }],
    });
    await store.release("run", "old");
    let executions = 0;

    const result = {
      kind: "succeeded" as const,
      output: 42,
      logs: [{ message: "result", data: null }],
    };

    const executor: Executor = {
      lookup: async (key, attempt) => {
        expect(key).toEqual(node.key);
        expect(attempt).toBe(2);

        return kind === "finished" ? { kind, result } : { kind };
      },
      execute: async (key, attempt) => {
        expect(key).toEqual(node.key);
        expect(attempt).toBe(2);
        executions++;

        return result;
      },
    };

    expect(await activate({ runId: "run", store, graph: plan, executor })).toEqual({
      status: "succeeded",
      output: 42,
    });
    expect(executions).toBe(kind === "none" ? 1 : 0);
    expect(await store.getNodeRuns("run")).toMatchObject([
      { attempt: 2, status: "succeeded", receipt: "finished" },
      { status: "succeeded" },
    ]);
    expect(await store.getLogs("run")).toHaveLength(1);
  },
);

test("retry retains ownership and running status, persists its deadline and keeps logs per attempt", async () => {
  let now = Date.parse(newRun().createdAt);
  const waiting = Promise.withResolvers<() => void>();

  const clock: Clock = {
    now: () => now,
    timeout: (callback, milliseconds) => {
      waiting.resolve(() => {
        now += milliseconds;
        callback();
      });

      return () => {};
    },
  };

  const store = new SqliteRunStore(":memory:", clock.now);
  await store.createRun(newRun());

  const executor: Executor = {
    lookup: async () => ({ kind: "none" }),
    execute: async (...args) =>
      args[1] === 1
        ? {
            kind: "failed",
            error: { code: "execution", message: "Temporary." },
            exitCode: null,
            logs: [{ message: "first", data: null }],
          }
        : { kind: "succeeded", output: 42, logs: [{ message: "second", data: null }] },
  };

  const running = activate({ runId: "run", store, executor, graph: graph(), clock });
  const resume = await waiting.promise;
  expect(await store.getRun("run")).toMatchObject({
    status: "running",
    owner: { token: expect.any(String) },
  });
  expect(await store.getNodeRuns("run")).toMatchObject([{ status: "retrying", attempt: 1 }]);
  resume();
  expect(await running).toEqual({ status: "succeeded", output: 42 });
  expect(
    (await store.getLogs("run")).map((log) => [
      log.message,
      log.position.kind === "node" ? log.position.attempt : null,
    ]),
  ).toEqual([
    ["first", 1],
    ["second", 2],
  ]);
});

test("a shared window of two delays the third dispatch without consuming an attempt", async () => {
  let now = Date.parse(newRun().createdAt);
  const waiting = Promise.withResolvers<() => void>();

  const clock: Clock = {
    now: () => now,
    timeout: (callback, ms) => {
      waiting.resolve(() => {
        now += ms;
        callback();
      });

      return () => {};
    },
  };

  const store = new SqliteRunStore(":memory:", clock.now);
  const rateLimit = { key: "shared", limit: 2, window: "1m" } as const;

  const plan = loopy("limited", {
    input: {},
    run: () => {
      sh(["printf", "first"], { rateLimit });
      sh(["printf", "second"], { rateLimit });

      return sh(["printf", "third"], { rateLimit });
    },
  }).graph;

  const attempts: number[] = [];

  const executor: Executor = {
    lookup: async () => ({ kind: "none" }),
    execute: async (...[, attempt]) => {
      attempts.push(attempt);

      return { kind: "succeeded", output: { stdout: "ok", stderr: "", exitCode: 0 }, logs: [] };
    },
  };

  await store.createRun(newRun());
  const running = activate({ runId: "run", store, graph: plan, executor, clock });
  const resume = await waiting.promise;
  expect(attempts).toEqual([1, 1]);
  expect(await store.getNodeRuns("run")).toMatchObject([
    { status: "succeeded" },
    { status: "succeeded" },
    { status: "rate_limited", attempt: 1 },
  ]);
  expect(await store.getRun("run")).toMatchObject({
    status: "running",
  });
  resume();
  expect(await running).toMatchObject({ status: "succeeded" });
  expect(attempts).toEqual([1, 1, 1]);
});
