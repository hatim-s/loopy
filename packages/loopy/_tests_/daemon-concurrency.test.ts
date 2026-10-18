import { expect, test } from "bun:test";
import { Daemon } from "../src/host/index.js";
import { loopy, sh } from "../src/sdk/graph/index.js";
import { MemoryStore } from "../src/store/index.js";
import { FakeExecutor, newRun } from "./fixture.js";

function fixture(concurrency: number) {
  const store = new MemoryStore();
  const entered = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  const active = new Set<string>();
  const calls: string[] = [];
  let peak = 0;
  const executor = new FakeExecutor();
  executor.execute = async (key) => {
    active.add(key.runId);
    calls.push(key.runId);
    peak = Math.max(peak, active.size);

    if (active.size === concurrency) {
      entered.resolve();
    }

    await gate.promise;
    expect((await store.getRun(key.runId))?.owner).toBeDefined();
    active.delete(key.runId);

    return { kind: "succeeded", output: { stdout: "done", stderr: "", exitCode: 0 }, logs: [] };
  };

  const graph = loopy("test", { input: {}, run: () => sh(["printf", "done"]) }).graph;

  const daemon = new Daemon({
    store,
    concurrency,
    revisionFor: () => "bundle",
    prepare: async () => ({ graph, executor }),
  });

  return { store, daemon, entered, gate, calls, peak: () => peak };
}

test("six graph runs respect concurrency two across overlapping ticks", async () => {
  const f = fixture(2);

  for (let i = 0; i < 6; i++) {
    await f.store.createRun({ ...newRun(), id: String(i) });
  }

  const ticking = f.daemon.tick();
  await f.entered.promise;
  const overlapping = f.daemon.tick();
  expect(f.peak()).toBe(2);
  f.gate.resolve();

  try {
    expect(await ticking).toEqual({ fired: 0, activated: 6 });
    await overlapping;
    expect(f.peak()).toBe(2);
    expect(new Set(f.calls).size).toBe(6);
    expect(f.calls).toHaveLength(6);
    expect(await f.store.listRuns({ status: "succeeded" })).toHaveLength(6);
  } finally {
    await f.daemon.stop();
  }
});

test("shutdown drains the active graph execution and leaves queued work untouched", async () => {
  const f = fixture(1);
  await f.store.createRun(newRun());
  await f.store.createRun({ ...newRun(), id: "pending" });
  let returned = false;

  const running = f.daemon.run().then(() => {
    returned = true;
  });

  await f.entered.promise;
  let stopped = false;

  const stopping = f.daemon.stop().then(() => {
    stopped = true;
  });

  await Promise.resolve();
  expect(stopped).toBe(false);
  expect(returned).toBe(false);
  f.gate.resolve();
  await stopping;
  await running;
  expect(returned).toBe(true);
  expect((await f.store.getRun("run"))?.status).toBe("succeeded");
  expect((await f.store.getRun("pending"))?.status).toBe("queued");
});

test("a held activation does not stop the running loop from processing new work and overdue schedules", async () => {
  let time = Date.parse("2026-10-18T00:00:00.000Z");
  const store = new MemoryStore(() => time);
  const held = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const completed = Promise.withResolvers<void>();
  const calls: string[] = [];
  const errors: Error[] = [];
  const executor = new FakeExecutor();
  executor.execute = async (key) => {
    calls.push(key.runId);

    if (key.runId === "held") {
      entered.resolve();
      await held.promise;
    }

    return { kind: "succeeded", output: { stdout: "done", stderr: "", exitCode: 0 }, logs: [] };
  };

  const graph = loopy("test", { input: {}, run: () => sh(["printf", "done"]) }).graph;

  const daemon = new Daemon({
    store,
    concurrency: 2,
    clock: { now: () => time, timeout: () => () => {} },
    revisionFor: () => "bundle",
    prepare: async () => ({ graph, executor }),
    onError: (error) => errors.push(error),
  });

  const unsubscribe = store.subscribe((events) => {
    if (
      events.some(
        (event) =>
          event.entity === "run" && event.kind === "finished" && event.record.id !== "held",
      )
    ) {
      void store.listRuns({ status: "succeeded" }).then((runs) => {
        if (runs.length === 2) {
          completed.resolve();
        }
      });
    }
  });

  await store.createRun({ ...newRun(), id: "held" });
  const running = daemon.run();

  try {
    await entered.promise;
    await store.createRun({ ...newRun(), id: "new" });
    await store.putSchedule({
      workspace: "/workspace",
      slug: "test",
      cron: "* * * * *",
      tz: "UTC",
      input: {},
      enabled: true,
      nextFireAt: "2026-10-18T00:01:00.000Z",
    });
    time += 65_000;
    daemon.wake();
    await Promise.race([
      completed.promise,
      Bun.sleep(3000).then(() => {
        throw new Error("New work and overdue schedule did not finish while held");
      }),
    ]);
    expect((await store.getRun("held"))?.status).toBe("running");
    expect(await store.listRuns({ status: "succeeded" })).toHaveLength(2);
    expect(new Set(calls).size).toBe(3);
    expect((await store.listSchedules())[0]?.nextFireAt).toBe("2026-10-18T00:02:00.000Z");
    expect(errors).toEqual([]);
  } finally {
    unsubscribe();
    held.resolve();
    await daemon.stop();
    await running;
  }
});
