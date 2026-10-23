import { expect, test } from "bun:test";
import type { Executor } from "../src/core/index.js";
import { activate } from "../src/host/activate.js";
import type { Clock } from "../src/host/clock.js";
import { Daemon } from "../src/host/daemon.js";
import { loopy, parallel, sh, sleep, wait } from "../src/sdk/graph/index.js";
import { MemoryStore } from "../src/store/index.js";
import { newRun } from "./fixture.js";
import { policyGraph, policyRetry, policySuccess } from "./host-policy-fixture.js";

for (const hold of ["retry", "rate-limit"] as const) {
  test(`concurrency one retains a ${hold} beside a wait and heartbeats before allowing the second run`, async () => {
    let now = Date.parse(newRun().createdAt);
    const store = new MemoryStore(() => now, 1000);
    const timer = Promise.withResolvers<{ callback: () => void; ms: number }>();

    const clock: Clock = {
      now: () => now,
      timeout: (callback, ms) => {
        timer.resolve({ callback, ms });

        return () => {};
      },
    };

    const graph =
      hold === "retry"
        ? policyGraph()
        : loopy("limited", {
            input: {},
            run: () =>
              parallel({
                work: () => sh(["true"], { rateLimit: { key: "shared", limit: 1, window: "1m" } }),
                approval: () => wait("approve", { payload: { kind: "value", type: "boolean" } }),
              }),
          }).graph;

    const starts: string[] = [];

    const executor: Executor = {
      lookup: async () => ({ kind: "none" }),
      execute: async (key, attempt) => {
        starts.push(`${key.runId}/${attempt}`);

        return hold === "retry" && key.runId === "run" && attempt === 1
          ? policyRetry
          : hold === "retry"
            ? policySuccess
            : {
                kind: "succeeded",
                output: { stdout: "", stderr: "", exitCode: 0 },
                logs: [],
              };
      },
    };

    await store.createRun(newRun());
    await store.createRun({ ...newRun(), id: "second" });

    if (hold === "rate-limit") {
      await store.acquireRateLimit("shared", 1, 60_000, newRun().createdAt);
    }

    const daemon = new Daemon({
      store,
      clock,
      concurrency: 1,
      prepare: async (run) => ({
        graph:
          hold === "rate-limit" && run.id === "second"
            ? loopy("second", {
                input: {},
                run: () =>
                  parallel({
                    work: () => sh(["true"]),
                    approval: () =>
                      wait("approve", { payload: { kind: "value", type: "boolean" } }),
                  }),
              }).graph
            : graph,
        executor,
      }),
      revisionFor: () => "bundle",
    });

    const heartbeat = Promise.withResolvers<void>();

    const unsubscribe = store.subscribe((events) => {
      if (events.some((event) => event.runId === "run" && event.kind === "heartbeat")) {
        heartbeat.resolve();
      }
    });

    const ticking = daemon.tick();

    try {
      const held = await Promise.race([
        timer.promise.then((retry) => ({ kind: "held" as const, retry })),
        ticking.then(() => ({ kind: "exited" as const })),
      ]);

      expect(held.kind).toBe("held");

      if (held.kind !== "held") {
        throw new Error("Activation released the slot before arming its retry.");
      }

      const retry = held.retry;
      expect(await store.getRun("run")).toMatchObject({
        status: "running",
        owner: { token: expect.any(String) },
      });
      expect((await store.getRun("second"))?.status).toBe("queued");
      expect(starts).toEqual(hold === "retry" ? ["run/1"] : []);
      // Store time passes past the original lease; the held activation must renew it.
      now += 1001;
      await heartbeat.promise;
      expect((await store.getRun("run"))?.owner?.heartbeatAt).toBe(new Date(now).toISOString());
      await expect(store.claim("run", "foreign")).rejects.toThrow("not owned by this token");
      now = Date.parse(newRun().createdAt) + retry.ms;
      const hook = (await store.getWaits("run"))[0];

      if (!hook) {
        throw new Error("Expected held approval.");
      }

      await store.resolveWait({
        token: hook.token,
        payload: true,
        at: new Date(now).toISOString(),
      });
      retry.callback();
      await ticking;
      expect((await store.getRun("run"))?.status).toBe("succeeded");
      expect(starts).toEqual(
        hold === "retry" ? ["run/1", "run/2", "second/1"] : ["run/1", "second/1"],
      );
      // The second run reaches its own approval and truly suspends.
      expect((await store.getRun("second"))?.status).toBe("suspended");
    } finally {
      unsubscribe();
      await daemon.stop();
    }
  });
}

test("a retry beside sleep keeps the local activation until both deadlines settle", async () => {
  let now = Date.parse(newRun().createdAt);
  const timers = new Map<number, () => void>();
  const ready = Promise.withResolvers<void>();

  const clock: Clock = {
    now: () => now,
    timeout: (callback, ms) => {
      timers.set(ms, callback);
      ready.resolve();

      return () => timers.delete(ms);
    },
  };

  const store = new MemoryStore(clock.now);

  const graph = loopy("sleep-retry", {
    input: {},
    run: () =>
      parallel({
        work: () => sh(["true"]),
        pause: () => sleep("2s"),
      }),
  }).graph;

  await store.createRun(newRun());

  const executor: Executor = {
    lookup: async () => ({ kind: "none" }),
    execute: async (...[, attempt]) =>
      attempt === 1
        ? policyRetry
        : {
            kind: "succeeded",
            output: { stdout: "", stderr: "", exitCode: 0 },
            logs: [],
          },
  };

  const running = activate({ store, graph, executor, clock, runId: "run" });
  await ready.promise;

  // Wait for the first completion to persist its retry before advancing time.
  for (let count = 0; count < 30 && !timers.has(1000); count++) {
    await Promise.resolve();
  }

  expect(await store.getRun("run")).toMatchObject({ status: "running" });
  expect(timers.has(1000)).toBe(true);
  now += 1000;
  timers.get(1000)?.();
  expect(await running).toEqual({ status: "suspended" });
  expect((await store.getRun("run"))?.wakeAt).toBe("2026-10-16T00:00:02.000Z");
  now += 1000;
  expect((await activate({ store, graph, executor, clock, runId: "run" })).status).toBe(
    "succeeded",
  );
});
