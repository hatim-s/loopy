import { expect, test } from "bun:test";
import { sleep, wait } from "@loopy/sdk/graph";
import { Effect } from "effect";
import { SCHEDULER } from "../src/scheduler";
import { base, expired, fixture, graph, work } from "./fixtures/scheduler";

for (const owner of ["fresh foreign", "expired foreign", "same token"] as const) {
  for (const waiting of ["due sleep", "future sleep", "indefinite wait"] as const) {
    test(`${owner} interrupted ${waiting} recovers without repeating effects`, async () => {
      const f = fixture();

      const paused = graph("paused", () => {
        work();

        return waiting === "indefinite wait"
          ? wait("approval", { payload: { kind: "value", type: "boolean" } })
          : sleep(waiting === "due sleep" ? "1s" : "1m");
      });

      f.provider.result = { kind: "finished", result: { kind: "succeeded", output: 1, logs: [] } };
      await f.run("paused", paused);
      f.store.releaseFailures = 1;
      await Effect.runPromise(f.scheduler().tick());
      expect(await Effect.runPromise(f.store.getRun("paused"))).toMatchObject({
        status: "suspended",
        owner: { token: "original" },
      });
      expect(f.storage.alarm).toBe(base + SCHEDULER.retryMs);
      expect(await f.turnErrors()).toEqual([
        {
          runId: "paused",
          error:
            "Storage operation 'release' failed: Release interrupted after suspension committed.",
        },
      ]);

      const scheduler = f.scheduler(owner === "same token" ? "original" : "replacement");
      f.at(owner === "expired foreign" ? expired : SCHEDULER.retryMs);
      await Effect.runPromise(scheduler.tick());

      if (owner === "fresh foreign") {
        expect((await Effect.runPromise(f.store.getRun("paused")))?.owner?.token).toBe("original");
        expect(f.storage.alarm).toBe(base + expired);
        f.at(SCHEDULER.leaseMs);
        await Effect.runPromise(scheduler.tick());
        expect((await Effect.runPromise(f.store.getRun("paused")))?.owner?.token).toBe("original");
        f.at(expired);
        await Effect.runPromise(scheduler.tick());
      }

      expect((await Effect.runPromise(f.store.getRun("paused")))?.owner).toBeUndefined();
      expect(f.provider.starts).toHaveLength(1);

      if (waiting === "indefinite wait") {
        expect((await Effect.runPromise(f.store.getRun("paused")))?.status).toBe("suspended");
        expect(await Effect.runPromise(f.store.getWaits("paused"))).toHaveLength(1);
        expect(f.storage.alarm).toBeNull();
        f.at(120_000);
        await Effect.runPromise(scheduler.tick());
        expect((await Effect.runPromise(f.store.getRun("paused")))?.status).toBe("suspended");
        expect(await Effect.runPromise(f.store.getWaits("paused"))).toHaveLength(1);
        expect(f.provider.starts).toHaveLength(1);
        expect(f.storage.alarm).toBeNull();
      } else {
        if (waiting === "future sleep") {
          expect(await Effect.runPromise(f.store.getRun("paused"))).toMatchObject({
            status: "suspended",
            wakeAt: new Date(base + 60_000).toISOString(),
          });
          expect(f.storage.alarm).toBe(base + 60_000);
          f.at(60_000);
          await Effect.runPromise(scheduler.tick());
        }

        expect((await Effect.runPromise(f.store.getRun("paused")))?.status).toBe("succeeded");
        expect(f.storage.alarm).toBeNull();
        expect(f.provider.starts).toHaveLength(1);
      }
    });
  }
}

test("a resolved hook supersedes the previous timeout alarm", async () => {
  const f = fixture();
  await f.run(
    "approval",
    graph("approval", () =>
      wait("approve", {
        timeout: "1m",
        payload: { kind: "value", type: "boolean" },
      }),
    ),
  );
  await Effect.runPromise(f.scheduler().tick());
  expect(f.storage.alarm).toBe(base + 60_000);
  const hook = (await Effect.runPromise(f.store.getWaits("approval")))[0];

  if (!hook) {
    throw new Error("Expected a persisted hook.");
  }

  f.at(1000);
  expect(
    await Effect.runPromise(
      f.store.resolveWait({ token: hook.token, payload: true, at: new Date().toISOString() }),
    ),
  ).toMatchObject({ kind: "resolved" });
  await Effect.runPromise(f.scheduler().tick());
  expect((await Effect.runPromise(f.store.getRun("approval")))?.status).toBe("succeeded");
  expect(f.storage.alarm).toBeNull();
});

test("a second release failure persists a retry without reactivating an indefinite wait", async () => {
  const f = fixture();
  await f.run(
    "paused",
    graph("paused", () => wait("approval", { payload: { kind: "value", type: "boolean" } })),
  );
  f.store.releaseFailures = 2;
  const scheduler = f.scheduler();
  await Effect.runPromise(scheduler.tick());
  f.at(SCHEDULER.retryMs);
  await Effect.runPromise(scheduler.tick());
  expect(f.storage.alarm).toBe(base + 2 * SCHEDULER.retryMs);
  expect((await Effect.runPromise(f.store.getRun("paused")))?.owner?.token).toBe("original");
  f.at(1.5 * SCHEDULER.retryMs);
  await Effect.runPromise(scheduler.tick());
  expect((await Effect.runPromise(f.store.getRun("paused")))?.owner?.token).toBe("original");
  expect(f.storage.alarm).toBe(base + 2 * SCHEDULER.retryMs);
  f.at(2 * SCHEDULER.retryMs);
  await Effect.runPromise(scheduler.tick());
  expect((await Effect.runPromise(f.store.getRun("paused")))?.owner).toBeUndefined();
  expect(await Effect.runPromise(f.store.getWaits("paused"))).toHaveLength(1);
  expect(f.provider.starts).toEqual([]);
  expect(f.storage.alarm).toBeNull();
});

test("suspended recovery releases an expired owner while every execution slot is occupied", async () => {
  const f = fixture(1);

  const paused = graph("paused", () => {
    sleep("1s");

    return work();
  });

  await f.run("paused", paused);
  f.store.releaseFailures = 1;
  await Effect.runPromise(f.scheduler().tick());
  await f.run("blocker", graph("blocker"));
  await Effect.runPromise(f.scheduler().tick());
  expect(f.provider.starts).toHaveLength(1);
  f.at(expired);
  const scheduler = f.scheduler("replacement");
  await Effect.runPromise(scheduler.tick());
  expect(await Effect.runPromise(f.store.getRun("paused"))).toMatchObject({
    status: "suspended",
    wakeAt: new Date(base + 1000).toISOString(),
  });
  expect((await Effect.runPromise(f.store.getRun("paused")))?.owner).toBeUndefined();
  expect(f.provider.starts).toHaveLength(1);
  expect(f.storage.alarm).toBe(base + expired + SCHEDULER.pollMs);
  f.provider.finishAll();
  f.at(expired + SCHEDULER.pollMs);
  await Effect.runPromise(scheduler.tick());
  f.at(expired + SCHEDULER.pollMs + SCHEDULER.alarmFloorMs);
  await Effect.runPromise(scheduler.tick());
  expect((await Effect.runPromise(f.store.getRun("paused")))?.status).toBe("running");
  expect(f.provider.starts).toHaveLength(2);
  expect(f.provider.runningCounts).toEqual([1, 1]);
});
