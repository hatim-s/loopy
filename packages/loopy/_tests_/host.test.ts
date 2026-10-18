import { expect, test } from "bun:test";
import type { Executor, Store } from "../src/core/index.js";
import { initialState, step } from "../src/engine/index.js";
import { activate } from "../src/host/index.js";
import { loopy, sh } from "../src/sdk/index.js";
import { SqliteRunStore } from "../src/store/index.js";
import { codeGraph, FakeClock, FakeExecutor, newRun, until } from "./fixture.js";

test.each(["none", "finished"] as const)(
  "host resumes the same persisted attempt from a %s receipt",
  async (kind) => {
    const store = new SqliteRunStore(":memory:");
    const plan = codeGraph();
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
    const lookups: Parameters<Executor["lookup"]>[] = [];
    const executions: Parameters<Executor["execute"]>[] = [];

    const result = {
      kind: "succeeded" as const,
      output: 42,
      logs: [{ message: "result", data: null }],
    };

    const executor: Executor = {
      lookup: async (...args) => {
        lookups.push(args);

        return kind === "finished" ? { kind, result } : { kind };
      },
      execute: async (...args) => {
        executions.push(args);

        return result;
      },
    };

    expect(await activate({ runId: "run", store, graph: plan, executor })).toEqual({
      status: "succeeded",
      output: 42,
    });
    expect(executions).toHaveLength(kind === "none" ? 1 : 0);
    expect(lookups).toEqual([[node.key, 2]]);
    expect(executions.map(([key, attempt]) => [key, attempt])).toEqual(
      kind === "none" ? [[node.key, 2]] : [],
    );
    expect(await store.getNodeRuns("run")).toMatchObject([
      { attempt: 2, status: "succeeded", receipt: "finished" },
      { status: "succeeded" },
    ]);
    expect(await store.getLogs("run")).toHaveLength(1);
  },
);

test("retry retains ownership and running status, persists its deadline and keeps logs per attempt", async () => {
  const clock = new FakeClock();

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

  const running = activate({ runId: "run", store, executor, graph: codeGraph(), clock });
  await until(async () =>
    (await store.getNodeRuns("run")).some((node) => node.status === "retrying"),
  );
  expect(await store.getRun("run")).toMatchObject({
    status: "running",
    owner: { token: expect.any(String) },
  });
  expect(await store.getNodeRuns("run")).toMatchObject([{ status: "retrying", attempt: 1 }]);
  clock.advance(1000);
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
  const clock = new FakeClock();

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
  await until(async () =>
    (await store.getNodeRuns("run")).some((node) => node.status === "rate_limited"),
  );
  expect(attempts).toEqual([1, 1]);
  expect(await store.getNodeRuns("run")).toMatchObject([
    { status: "succeeded" },
    { status: "succeeded" },
    { status: "rate_limited", attempt: 1 },
  ]);
  expect(await store.getRun("run")).toMatchObject({
    status: "running",
  });
  clock.advance(60_000);
  expect(await running).toMatchObject({ status: "succeeded" });
  expect(attempts).toEqual([1, 1, 1]);
});

async function execute(store: Store, executor = new FakeExecutor()) {
  await store.createRun(newRun());

  return activate({ store, executor, graph: codeGraph(), runId: "run" });
}

class ReadFailureStore extends SqliteRunStore {
  override async getNodeRuns(): Promise<never> {
    throw new Error("Nodes unavailable. Restore storage.");
  }
}

class ReleaseFailureStore extends ReadFailureStore {
  override async release(runId: string, token: string) {
    await super.release(runId, token);
    throw new Error("Release unavailable. Restore storage.");
  }
}

test("node read failure releases ownership into a claimable suspension", async () => {
  const store = new ReadFailureStore(":memory:");
  await expect(execute(store)).rejects.toThrow("Nodes unavailable");
  expect(await store.getRun("run")).toMatchObject({ status: "suspended" });
  expect((await store.getRun("run"))?.owner).toBeUndefined();
  expect((await store.claim("run", "next")).status).toBe("running");
});

test("release failure remains the cause of the primary read failure", async () => {
  await expect(execute(new ReleaseFailureStore(":memory:"))).rejects.toMatchObject({
    message: "Nodes unavailable. Restore storage.",
    cause: new Error("Release unavailable. Restore storage."),
  });
});

for (const operation of ["dispatch", "finish"] as const) {
  test(`${operation} persistence failure releases ownership and does not dispatch uncommitted work`, async () => {
    class WriteFailureStore extends SqliteRunStore {
      override async apply(batch: Parameters<Store["apply"]>[0]) {
        if (
          operation === "dispatch" ||
          batch.effects.some((effect) => effect.kind === "finish_run")
        ) {
          throw new Error("Write unavailable. Restore storage.");
        }

        return super.apply(batch);
      }
    }

    const store = new WriteFailureStore(":memory:");
    const executor = new FakeExecutor();
    executor.result = { kind: "succeeded", output: 42, logs: [] };
    await expect(execute(store, executor)).rejects.toThrow("Write unavailable");
    expect(executor.calls).toHaveLength(operation === "dispatch" ? 0 : 1);
    expect((await store.getRun("run"))?.owner).toBeUndefined();
    expect((await store.dueRuns(new Date().toISOString())).map((run) => run.id)).toEqual(["run"]);
  });
}

test("release failure preserves a failed graph outcome as the primary message", async () => {
  class TerminalReleaseFailureStore extends SqliteRunStore {
    override async release(runId: string, token: string) {
      await super.release(runId, token);
      throw new Error("Release unavailable");
    }
  }

  const executor = new FakeExecutor();
  executor.result = {
    kind: "failed",
    error: { code: "protocol", message: "Invalid bundle protocol" },
    exitCode: null,
    logs: [],
  };
  await expect(
    execute(new TerminalReleaseFailureStore(":memory:"), executor),
  ).rejects.toMatchObject({
    message: "Invalid bundle protocol",
    cause: new Error("Release unavailable"),
  });
});
