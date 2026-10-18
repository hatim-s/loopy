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
