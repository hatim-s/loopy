import { expect, test } from "bun:test";
import type { Store } from "../src/core/index.js";
import { activate, type Clock } from "../src/host/index.js";
import { code, loopy } from "../src/sdk/graph/index.js";
import { SqliteRunStore } from "../src/store/index.js";
import { FakeExecutor, newRun } from "./fixture.js";

function graph() {
  const graph = loopy("test", {
    input: {},
    run: () =>
      code("work", { in: {}, out: { kind: "value", type: "number" }, module: "./work.ts" }),
  }).graph;

  for (const node of graph.nodes) {
    if (node.kind === "code") {
      node.module.bundleHash = "a".repeat(64);
    }
  }

  return graph;
}

async function execute(store: Store, executor = new FakeExecutor()) {
  await store.createRun(newRun());

  return activate({ store, executor, graph: graph(), runId: "run" });
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

test("all three attempts retain their own logs and indices", async () => {
  let now = Date.parse(newRun().createdAt);

  const clock: Clock = {
    now: () => now,
    timeout: (callback, ms) => {
      queueMicrotask(() => {
        now += ms;
        callback();
      });

      return () => {};
    },
  };

  const store = new SqliteRunStore(":memory:", clock.now);
  await store.createRun(newRun());
  const executor = new FakeExecutor();
  executor.execute = async (...[, attempt]) =>
    attempt < 3
      ? {
          kind: "failed",
          error: { code: "execution", message: "Temporary" },
          exitCode: null,
          logs: [{ message: "attempt", data: attempt }],
        }
      : { kind: "succeeded", output: 42, logs: [{ message: "attempt", data: attempt }] };
  expect(await activate({ runId: "run", store, executor, graph: graph(), clock })).toEqual({
    status: "succeeded",
    output: 42,
  });
  expect((await store.getLogs("run")).map((log) => [log.data, log.position])).toEqual(
    [1, 2, 3].map((attempt) => [
      attempt,
      { kind: "node", executionKey: '"run"/"0:work"', attempt, index: 0 },
    ]),
  );
});
