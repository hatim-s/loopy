import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Graph, type RunRecord, type Schedule, StoreError } from "../src/core/index.js";
import { Daemon } from "../src/host/index.js";
import { loopy, sh } from "../src/sdk/graph/index.js";
import { SqliteRunStore } from "../src/store/index.js";
import { FakeClock, FakeExecutor, newRun, until } from "./fixture.js";

const cleanups: (() => void | Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

function fixture(
  options: Partial<ConstructorParameters<typeof Daemon>[0]> & {
    graphFor?: (run: RunRecord) => Promise<Graph>;
  } = {},
) {
  const clock = new FakeClock();
  const store = options.store ?? new SqliteRunStore(":memory:", clock.now);
  const errors: { error: Error; run?: RunRecord }[] = [];

  const daemon = new Daemon({
    concurrency: 4,
    store,
    clock,
    revisionFor: () => "bundle",
    prepare: async (run) => ({
      graph: options.graphFor
        ? await options.graphFor(run)
        : loopy("test", {
            input: { "value?": "number", "scheduled?": "boolean" },
            run: ({ input }) => input,
          }).graph,
      executor: new FakeExecutor(),
    }),
    onError: (error, run) => errors.push({ error, run }),
    ...options,
  });

  cleanups.push(async () => {
    await daemon.stop();

    if (store instanceof SqliteRunStore) {
      store.close();
    }
  });

  return { store, daemon, errors, clock };
}

function schedule(overrides: Partial<Schedule> = {}): Schedule {
  return {
    version: 1,
    workspace: "/workspace",
    slug: "test",
    cron: "* * * * *",
    tz: "UTC",
    input: { scheduled: true },
    enabled: true,
    nextFireAt: newRun().createdAt,
    ...overrides,
  };
}

test("a due schedule fires once per key and the next minute fires a new run", async () => {
  const f = fixture();
  await f.store.putSchedule(schedule());
  void f.daemon.run();
  await until(async () => (await f.store.listRuns({ status: "succeeded" })).length === 1);
  const runs = await f.store.listRuns();
  expect(runs[0]).toMatchObject({ slug: "test", revision: "bundle", output: { scheduled: true } });
  expect(runs[0]?.id).toMatch(/^[\da-f-]{36}$/u);
  expect(await f.store.listSchedules()).toEqual([
    schedule({ lastFireKey: "test@2026-10-16T00:00Z", nextFireAt: "2026-10-16T00:01:00.000Z" }),
  ]);
  f.daemon.wake();
  await until(() => f.clock.sleeps.length >= 2);
  expect(await f.store.listRuns()).toHaveLength(1);
  f.clock.advance(60_000);
  f.daemon.wake();
  await until(async () => (await f.store.listRuns({ status: "succeeded" })).length === 2);
});

test("disabled schedules do not fire", async () => {
  const f = fixture();
  await f.store.putSchedule(schedule({ enabled: false }));
  void f.daemon.run();
  await until(() => f.clock.sleeps.length > 0);
  expect(await f.store.listRuns()).toEqual([]);
});

test("startup skips stale schedules forward without firing and preserves the fire key", async () => {
  const f = fixture();
  await f.store.putSchedule(
    schedule({ nextFireAt: "2026-10-15T23:58:00.000Z", lastFireKey: "old" }),
  );
  void f.daemon.run();
  await until(() => f.clock.sleeps.length > 0);
  expect(await f.store.listRuns()).toEqual([]);
  expect(await f.store.listSchedules()).toEqual([
    schedule({ lastFireKey: "old", nextFireAt: "2026-10-16T00:01:00.000Z" }),
  ]);
  f.clock.advance(60_000);
  f.daemon.wake();
  await until(async () => (await f.store.listRuns({ status: "succeeded" })).length === 1);
});

test("startup permits a schedule exactly one minute late", async () => {
  const f = fixture();
  await f.store.putSchedule(schedule({ nextFireAt: "2026-10-15T23:59:00.000Z" }));
  void f.daemon.run();
  await until(async () => (await f.store.listRuns({ status: "succeeded" })).length >= 1);
  expect(await f.store.events(0, 100)).toContainEqual(
    expect.objectContaining({
      entity: "schedule",
      kind: "fired",
      record: expect.objectContaining({ lastFireKey: "test@2026-10-15T23:59Z" }),
    }),
  );
});

test("a queued run activates and completes", async () => {
  const f = fixture();
  await f.store.createRun(newRun());
  void f.daemon.run();
  await until(
    async () =>
      !(await f.store.getRun("run"))?.owner &&
      (await f.store.getRun("run"))?.status === "succeeded",
  );
  expect(await f.store.getRun("run")).toMatchObject({ output: { value: 42 } });
});

test("a throwing loader reports its run and other runs still activate", async () => {
  const failure = new Error("Workflow could not load. Save the workflow again.");

  const f = fixture({
    graphFor: async (run) => {
      if (run.id === "bad") {
        throw failure;
      }

      return loopy("test", { input: {}, run: () => "done" }).graph;
    },
  });

  await f.store.createRun({ ...newRun(), id: "bad" });
  await f.store.createRun(newRun());
  void f.daemon.run();
  await until(
    async () => (await f.store.getRun("run"))?.status === "succeeded" && f.errors.length === 1,
  );
  expect(f.errors).toEqual([{ error: failure, run: { ...newRun(), id: "bad" } }]);
  expect(await f.store.getRun("bad")).toMatchObject({ status: "failed" });
  expect((await f.store.getRun("bad"))?.owner).toBeUndefined();
});

test("a throwing activation releases ownership and does not block other runs", async () => {
  const failure = new Error("Journal could not load. Restore storage.");

  class BrokenJournalStore extends SqliteRunStore {
    override async getNodeRuns(runId: string) {
      if (runId === "bad") {
        throw failure;
      }

      return super.getNodeRuns(runId);
    }
  }

  const store = new BrokenJournalStore(":memory:", () => Date.parse(newRun().createdAt));
  const f = fixture({ store });
  await store.createRun({ ...newRun(), id: "bad" });
  await store.createRun(newRun());
  void f.daemon.run();
  await until(
    async () => (await store.getRun("run"))?.status === "succeeded" && f.errors.length > 0,
  );
  await f.daemon.stop();
  expect(f.errors[0]).toMatchObject({ error: failure, run: { id: "bad" } });
  expect((await store.getRun("bad"))?.owner).toBeUndefined();
  expect((await store.dueRuns(newRun().createdAt)).map((run) => run.id)).toEqual(["bad"]);
});

test("a failed wake lookup reports once and retries after an abortable capped wait", async () => {
  const failure = new Error("Wake lookup failed. Retry storage.");
  let lookups = 0;

  class FlakyWakeStore extends SqliteRunStore {
    override async nextWakeAt() {
      lookups++;

      if (lookups === 1) {
        throw failure;
      }

      return super.nextWakeAt();
    }
  }

  const f = fixture({ store: new FlakyWakeStore(":memory:") });
  void f.daemon.run();
  await until(() => f.clock.sleeps.length === 1);
  expect(f.clock.sleeps).toEqual([5000]);
  expect(f.errors).toEqual([{ error: failure, run: undefined }]);
  f.clock.advance(5000);
  await until(() => lookups === 2);
  expect(f.errors).toHaveLength(1);
});

test("failed activations back off from one second to the five second cap", async () => {
  const failure = new Error("Journal lookup failed. Restore storage.");

  class BrokenJournalStore extends SqliteRunStore {
    override async getNodeRuns(): Promise<never> {
      throw failure;
    }
  }

  const f = fixture({
    store: new BrokenJournalStore(":memory:", () => Date.parse(newRun().createdAt)),
  });

  await f.store.createRun(newRun());
  void f.daemon.run();

  for (const [index, delay] of [1000, 2000, 4000, 5000].entries()) {
    await until(
      () =>
        f.errors.length === index + 1 &&
        f.clock.sleeps.filter((ms) => ms <= 5000).length === index + 1,
    );
    expect(f.clock.sleeps.filter((ms) => ms <= 5000)[index]).toBe(delay);
    expect(f.errors[index]?.error).toBe(failure);
    expect((await f.store.getRun("run"))?.owner).toBeUndefined();

    if (index < 3) {
      await Bun.sleep(1);
      f.clock.advance(delay);
    }
  }
});

test("claim contention does not report an activation error", async () => {
  class ContendedStore extends SqliteRunStore {
    override async claim(): Promise<RunRecord> {
      throw new StoreError("owned_elsewhere");
    }
  }

  const f = fixture({ store: new ContendedStore(":memory:") });
  await f.store.createRun(newRun());
  void f.daemon.run();
  await until(() => f.clock.sleeps.length > 0);
  expect(f.errors).toEqual([]);
});

test("the loop prunes old events at startup and each hour", async () => {
  const f = fixture();
  await f.store.createRun({ ...newRun(), status: "succeeded" });
  f.clock.advance(3_600_000);
  await f.store.putSchedule(schedule({ enabled: false, nextFireAt: "2099-01-01T00:00:00.000Z" }));
  f.clock.advance(23 * 3_600_000 + 1);
  void f.daemon.run();
  await until(() => f.clock.sleeps.length === 1);
  expect((await f.store.events(0, 100)).map((event) => event.entity)).toEqual(["schedule"]);
  f.clock.advance(3_600_000 - 1);
  await until(() => f.clock.sleeps.length === 2);
  expect(await f.store.events(0, 100)).toHaveLength(1);
  f.clock.advance(1);
  f.daemon.wake();
  await until(() => f.clock.sleeps.length >= 3);
  expect(await f.store.events(0, 100)).toEqual([]);
  expect(f.errors).toEqual([]);
});

for (const mutation of ["PUT", "disable"] as const) {
  test(`SQLite startup catch-up preserves a concurrent ${mutation} of a later overdue schedule`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "loopy-catch-up-"));
    const file = join(directory, "runs.sqlite");
    const store = new SqliteRunStore(file);
    const writer = new SqliteRunStore(file);
    cleanups.push(() => {
      writer.close();
      store.close();
      rmSync(directory, { recursive: true, force: true });
    });
    const entered = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<string>();

    const f = fixture({
      store,
      revisionFor: () => {
        entered.resolve();

        return gate.promise;
      },
    });

    await store.putSchedule(schedule({ slug: "a-first" }));

    const overdue = await store.putSchedule(
      schedule({ slug: "z-later", nextFireAt: "2026-10-15T23:58:00.000Z" }),
    );

    void f.daemon.run();
    await entered.promise;

    const committed =
      mutation === "disable"
        ? await writer.setScheduleEnabled({ ...overdue, enabled: false })
        : await writer.putSchedule({
            ...overdue,
            cron: "0 * * * *",
            input: { edited: true },
            nextFireAt: "2026-10-16T01:00:00.000Z",
          });

    gate.resolve("bundle");
    await until(async () => (await store.listRuns({ status: "succeeded" })).length === 1);
    expect((await writer.listSchedules()).find((row) => row.slug === overdue.slug)).toEqual(
      committed,
    );
    expect(f.errors).toEqual([]);
  });
}

function concurrencyFixture(concurrency: number) {
  const clock = new FakeClock();
  const store = new SqliteRunStore(":memory:", clock.now);
  const entered = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  const active = new Set<string>();
  const calls: string[] = [];
  let peak = 0;
  const owners: boolean[] = [];
  const executor = new FakeExecutor();
  executor.execute = async (key) => {
    active.add(key.runId);
    calls.push(key.runId);
    peak = Math.max(peak, active.size);

    if (active.size === concurrency) {
      entered.resolve();
    }

    await gate.promise;
    owners.push(Boolean((await store.getRun(key.runId))?.owner));
    active.delete(key.runId);

    return { kind: "succeeded", output: { stdout: "done", stderr: "", exitCode: 0 }, logs: [] };
  };

  const graph = loopy("test", { input: {}, run: () => sh(["printf", "done"]) }).graph;

  const daemon = new Daemon({
    store,
    clock,
    concurrency,
    revisionFor: () => "bundle",
    prepare: async () => ({ graph, executor }),
  });

  cleanups.push(async () => {
    gate.resolve();
    await daemon.stop();
    store.close();
  });

  return { store, daemon, entered, gate, calls, owners, peak: () => peak };
}

test("six graph runs respect concurrency two through the running loop", async () => {
  const f = concurrencyFixture(2);

  for (let i = 0; i < 6; i++) {
    await f.store.createRun({ ...newRun(), id: String(i) });
  }

  const running = f.daemon.run();
  await f.entered.promise;
  expect(f.daemon.run()).toBe(running);
  expect(f.peak()).toBe(2);
  f.gate.resolve();

  try {
    await until(async () => (await f.store.listRuns({ status: "succeeded" })).length === 6);
    expect(f.owners).toEqual([true, true, true, true, true, true]);
    expect(f.peak()).toBe(2);
    expect(new Set(f.calls).size).toBe(6);
    expect(f.calls).toHaveLength(6);
    expect(await f.store.listRuns({ status: "succeeded" })).toHaveLength(6);
  } finally {
    await f.daemon.stop();
  }
});

test("shutdown drains the active graph execution and leaves queued work untouched", async () => {
  const f = concurrencyFixture(1);
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
  const clock = new FakeClock(Date.parse("2026-10-18T00:00:00.000Z"));
  const store = new SqliteRunStore(":memory:", clock.now);
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
    clock,
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
    clock.advance(65_000);
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
    store.close();
  }
});
