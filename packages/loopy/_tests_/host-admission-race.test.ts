import { expect, test } from "bun:test";
import type { Executor } from "../src/core/index.js";
import { activate } from "../src/host/activate.js";
import type { Clock } from "../src/host/clock.js";
import { loopy, parallel, sh, wait } from "../src/sdk/graph/index.js";
import { MemoryStore } from "../src/store/index.js";
import { newRun } from "./fixture.js";

test("local admission commits work first and reloads a signal before reducing rate denial", async () => {
  let now = Date.parse(newRun().createdAt);
  const timer = Promise.withResolvers<() => void>();

  const clock: Clock = {
    now: () => now,
    timeout: (callback, ms) => {
      timer.resolve(() => {
        now += ms;
        callback();
      });

      return () => {};
    },
  };

  const store = new MemoryStore(clock.now);

  const graph = loopy("admission-race", {
    input: {},
    run: () =>
      parallel({
        work: () => sh(["true"], { rateLimit: { key: "shared", limit: 1, window: "1m" } }),
        approval: () => wait("approve", { payload: { kind: "value", type: "boolean" } }),
      }),
  }).graph;

  await store.createRun(newRun());
  await store.acquireRateLimit("shared", 1, 60_000, newRun().createdAt);
  const acquire = store.acquireRateLimit.bind(store);
  let signalled = false;
  store.acquireRateLimit = async (...args) => {
    if (!signalled) {
      signalled = true;
      const hook = (await store.getWaits("run"))[0];
      expect(await store.getNodeRuns("run")).toEqual(
        expect.arrayContaining([expect.objectContaining({ status: "running", attempt: 1 })]),
      );

      if (!hook) {
        throw new Error("Admission started before the wait was committed.");
      }

      expect(
        await store.resolveWait({
          token: hook.token,
          payload: true,
          at: new Date(now).toISOString(),
        }),
      ).toMatchObject({ kind: "resolved" });
    }

    return acquire(...args);
  };

  const attempts: number[] = [];

  const executor: Executor = {
    lookup: async () => ({ kind: "none" }),
    execute: async (...[, attempt]) => {
      attempts.push(attempt);

      return { kind: "succeeded", output: { stdout: "", stderr: "", exitCode: 0 }, logs: [] };
    },
  };

  const running = activate({ store, graph, executor, clock, runId: "run" });
  const resume = await timer.promise;
  expect(await store.getNodeRuns("run")).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ status: "succeeded", output: true }),
      expect.objectContaining({ status: "rate_limited", attempt: 1 }),
    ]),
  );
  expect(attempts).toEqual([]);
  resume();
  expect(await running).toMatchObject({ status: "succeeded", output: { approval: true } });
  expect(attempts).toEqual([1]);
});
