import { expect, test } from "bun:test";
import type { EngineRun, Schedule } from "../src/core/index.js";
import {
  type ActivationOptions,
  type Clock,
  Daemon,
  MemoryRunStore,
  OwnershipError,
} from "../src/runtime/index.js";
import { FakeExecutor, newRun } from "./engine-fixture.js";

function fixture(options: Partial<ConstructorParameters<typeof Daemon>[0]> = {}) {
  let time = Date.parse(newRun().createdAt);

  const clock: Clock = {
    now: () => time,
    timeout: () => {
      throw new Error("Unexpected timer. Use a deferred promise in this test.");
    },
  };

  const store = options.store ?? new MemoryRunStore(clock.now);
  const errors: { error: Error; run?: EngineRun }[] = [];

  const daemon = new Daemon({
    store,
    clock,
    executor: new FakeExecutor(),
    loadWorkflow: async () => async (ctx) => ctx.input,
    cwdFor: () => "/workspace",
    modeFor: () => "sandbox",
    onError: (error, run) => errors.push({ error, run }),
    ...options,
  });

  return {
    store,
    daemon,
    errors,
    advance: (milliseconds: number) => {
      time += milliseconds;
    },
  };
}

function schedule(overrides: Partial<Schedule> = {}): Schedule {
  return {
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
  expect(await f.daemon.tick()).toEqual({ fired: 1, activated: 1 });
  expect(await f.daemon.tick()).toEqual({ fired: 0, activated: 0 });
  const runs = await f.store.listRuns();
  expect(runs).toHaveLength(1);
  expect(runs[0]).toMatchObject({ slug: "test", bundleHash: "", output: { scheduled: true } });
  expect(runs[0]?.id).toMatch(/^[\da-f-]{36}$/u);
  expect(await f.store.listSchedules()).toEqual([
    schedule({
      lastFireKey: "test@2026-10-16T00:00Z",
      nextFireAt: "2026-10-16T00:01:00.000Z",
    }),
  ]);
  f.advance(60_000);
  expect(await f.daemon.tick()).toEqual({ fired: 1, activated: 1 });
  expect(await f.store.listRuns()).toHaveLength(2);
});

test("disabled schedules do not fire", async () => {
  const f = fixture();
  await f.store.putSchedule(schedule({ enabled: false }));
  expect(await f.daemon.tick()).toEqual({ fired: 0, activated: 0 });
  expect(await f.store.listRuns()).toEqual([]);
});

test("startup skips stale schedules forward without firing and preserves the fire key", async () => {
  const f = fixture();
  await f.store.putSchedule(
    schedule({ nextFireAt: "2026-10-15T23:58:00.000Z", lastFireKey: "old" }),
  );
  expect(await f.daemon.tick()).toEqual({ fired: 0, activated: 0 });
  expect(await f.store.listSchedules()).toEqual([
    schedule({
      lastFireKey: "old",
      nextFireAt: "2026-10-16T00:01:00.000Z",
    }),
  ]);
  f.advance(60_000);
  expect(await f.daemon.tick()).toEqual({ fired: 1, activated: 1 });
});

test("startup permits a schedule exactly one minute late", async () => {
  const f = fixture();
  await f.store.putSchedule(schedule({ nextFireAt: "2026-10-15T23:59:00.000Z" }));
  expect(await f.daemon.tick()).toEqual({ fired: 1, activated: 1 });
});

test("a queued run activates and completes", async () => {
  const f = fixture();
  await f.store.createRun(newRun());
  expect(await f.daemon.tick()).toEqual({ fired: 0, activated: 1 });
  expect(await f.store.getRun("run")).toMatchObject({ status: "succeeded", output: { value: 42 } });
  expect((await f.store.getRun("run"))?.owner).toBeUndefined();
});

test("a sleeping run activates again only after its wake time", async () => {
  const workflow: ActivationOptions["workflow"] = async (ctx) => {
    await ctx.sleep("1h");

    return "awake";
  };

  const f = fixture({ loadWorkflow: async () => workflow });
  await f.store.createRun(newRun());
  expect((await f.daemon.tick()).activated).toBe(1);
  expect(await f.store.getRun("run")).toMatchObject({
    status: "suspended",
    wakeAt: "2026-10-16T01:00:00.000Z",
  });
  expect((await f.daemon.tick()).activated).toBe(0);
  f.advance(3_600_000);
  expect((await f.daemon.tick()).activated).toBe(1);
  expect(await f.store.getRun("run")).toMatchObject({ status: "succeeded", output: "awake" });
});

test("six runs respect concurrency two even with overlapping ticks", async () => {
  let active = 0;
  let peak = 0;
  const entered = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();

  const f = fixture({
    concurrency: 2,
    loadWorkflow: async () => async (ctx) =>
      ctx.step("hold", async () => {
        active++;
        peak = Math.max(peak, active);

        if (active === 2) {
          entered.resolve();
        }

        await gate.promise;
        active--;

        return null;
      }),
  });

  for (let index = 0; index < 6; index++) {
    await f.store.createRun({ ...newRun(), id: String(index) });
  }

  const ticking = f.daemon.tick();
  await entered.promise;
  const overlapping = f.daemon.tick();
  expect(peak).toBe(2);
  gate.resolve();
  expect(await ticking).toEqual({ fired: 0, activated: 6 });
  await overlapping;
  expect(peak).toBe(2);
  expect((await f.store.listRuns({ status: "succeeded" })).length).toBe(6);
  expect(f.errors).toEqual([]);
});

test("a throwing loader reports its run and other runs still activate", async () => {
  const failure = new Error("Workflow could not load. Save the workflow again.");

  const f = fixture({
    loadWorkflow: async (run) => {
      if (run.id === "bad") {
        throw failure;
      }

      return async () => "done";
    },
  });

  await f.store.createRun({ ...newRun(), id: "bad" });
  await f.store.createRun(newRun());
  expect(await f.daemon.tick()).toEqual({ fired: 0, activated: 1 });
  expect(f.errors).toEqual([{ error: failure, run: { ...newRun(), id: "bad" } }]);
  expect((await f.store.getRun("run"))?.status).toBe("succeeded");
  expect((await f.store.getRun("bad"))?.status).toBe("queued");
});

test("a throwing activation releases ownership and does not block other runs", async () => {
  const failure = new Error("Journal could not load. Restore storage.");

  class BrokenJournalStore extends MemoryRunStore {
    override async getSteps(runId: string) {
      if (runId === "bad") {
        throw failure;
      }

      return super.getSteps(runId);
    }
  }

  const store = new BrokenJournalStore(() => Date.parse(newRun().createdAt));
  const f = fixture({ store });
  await store.createRun({ ...newRun(), id: "bad" });
  await store.createRun(newRun());
  expect(await f.daemon.tick()).toEqual({ fired: 0, activated: 1 });
  expect(f.errors[0]?.error).toBe(failure);
  expect(f.errors[0]?.run?.id).toBe("bad");
  expect((await store.getRun("bad"))?.owner).toBeUndefined();
  expect((await store.dueRuns(newRun().createdAt)).map((run) => run.id)).toEqual(["bad"]);
  expect((await store.getRun("run"))?.status).toBe("succeeded");
});

test("stop waits for an in-flight activation and the run loop to return", async () => {
  const entered = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();

  const f = fixture({
    concurrency: 1,
    loadWorkflow: async () => async (ctx) =>
      ctx.step("hold", async () => {
        entered.resolve();
        await gate.promise;

        return "done";
      }),
  });

  await f.store.createRun(newRun());
  await f.store.createRun({ ...newRun(), id: "pending" });
  let returned = false;

  const running = f.daemon.run().then(() => {
    returned = true;
  });

  await entered.promise;
  let stopped = false;

  const stopping = f.daemon.stop().then(() => {
    stopped = true;
  });

  await Promise.resolve();
  expect(stopped).toBe(false);
  expect(returned).toBe(false);
  gate.resolve();
  await stopping;
  expect(returned).toBe(true);
  await running;
  expect((await f.store.getRun("run"))?.status).toBe("succeeded");
  expect((await f.store.getRun("pending"))?.status).toBe("queued");
});

function sleeper() {
  const calls: { milliseconds: number; signal: AbortSignal }[] = [];
  let entered = Promise.withResolvers<void>();

  const sleep = async (milliseconds: number, signal: AbortSignal) => {
    calls.push({ milliseconds, signal });
    entered.resolve();
    await new Promise<void>((resolve) => {
      if (signal.aborted) {
        resolve();

        return;
      }

      signal.addEventListener("abort", () => resolve(), { once: true });
    });
    entered = Promise.withResolvers<void>();
  };

  return { calls, sleep, entered: () => entered.promise };
}

for (const [runDelay, scheduleDelay, expected] of [
  [1000, 2000, 1000],
  [2000, 1000, 1000],
  [10_000, 20_000, 5000],
] satisfies [number, number, number][]) {
  test(`the loop sleeps ${expected}ms for run ${runDelay}ms and schedule ${scheduleDelay}ms`, async () => {
    const sleeping = sleeper();
    const f = fixture({ sleep: sleeping.sleep });
    const at = Date.parse(newRun().createdAt);
    await f.store.createRun({
      ...newRun(),
      status: "suspended",
      wakeAt: new Date(at + runDelay).toISOString(),
    });
    await f.store.putSchedule(schedule({ nextFireAt: new Date(at + scheduleDelay).toISOString() }));
    const running = f.daemon.run();
    await sleeping.entered();
    expect(sleeping.calls[0]?.milliseconds).toBe(expected);
    await f.daemon.stop();
    await running;
    expect(sleeping.calls[0]?.signal.aborted).toBe(true);
  });
}

test("wake interrupts an idle wait and activates new queued work", async () => {
  const sleeping = sleeper();
  const f = fixture({ sleep: sleeping.sleep });
  const running = f.daemon.run();
  await sleeping.entered();
  await f.store.createRun(newRun());
  f.daemon.wake();
  await Promise.resolve();
  await sleeping.entered();
  await until(async () => (await f.store.getRun("run"))?.status === "succeeded");
  await f.daemon.stop();
  await running;
});

async function until(ready: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (await ready()) {
      return;
    }

    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }

  throw new Error("Daemon did not reach the expected state. Inspect the loop and pool.");
}

function steppingSleeper() {
  const calls: { milliseconds: number; resume: () => void }[] = [];

  const sleep = (milliseconds: number, signal: AbortSignal) => {
    const gate = Promise.withResolvers<void>();
    calls.push({ milliseconds, resume: () => gate.resolve() });

    if (signal.aborted) {
      gate.resolve();
    } else {
      signal.addEventListener("abort", () => gate.resolve(), { once: true });
    }

    return gate.promise;
  };

  return { calls, sleep };
}

test("a held activation leaves capacity for new work and overdue schedules", async () => {
  const gate = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const sleeping = steppingSleeper();

  const f = fixture({
    concurrency: 2,
    sleep: sleeping.sleep,
    loadWorkflow: async (run) => async () => {
      if (run.id === "held") {
        entered.resolve();
        await gate.promise;
      }

      return "done";
    },
  });

  await f.store.putSchedule(schedule({ nextFireAt: "2026-10-16T00:01:00.000Z" }));
  await f.store.createRun({ ...newRun(), id: "held" });
  const running = f.daemon.run();
  await entered.promise;
  f.advance(120_000);
  await f.store.createRun(newRun());
  f.daemon.wake();

  try {
    await until(async () => (await f.store.getRun("run"))?.status === "succeeded");
    await until(async () => (await f.store.listRuns({ status: "succeeded" })).length >= 2);
    expect((await f.store.getRun("held"))?.status).toBe("running");
    expect((await f.store.listSchedules())[0]?.lastFireKey).toBe("test@2026-10-16T00:02Z");
    expect(f.errors).toEqual([]);
  } finally {
    gate.resolve();
    await f.daemon.stop();
    await running;
  }
});

test("a failed wake lookup reports once and retries after an abortable capped wait", async () => {
  const failure = new Error("Wake lookup failed. Retry storage.");
  let lookups = 0;

  class FlakyWakeStore extends MemoryRunStore {
    override async nextWakeAt() {
      lookups++;

      if (lookups === 1) {
        throw failure;
      }

      return super.nextWakeAt();
    }
  }

  const sleeping = steppingSleeper();
  const f = fixture({ store: new FlakyWakeStore(), sleep: sleeping.sleep });
  const running = f.daemon.run();

  try {
    await until(() => sleeping.calls.length === 1);
    expect(sleeping.calls[0]?.milliseconds).toBe(5000);
    expect(f.errors).toEqual([{ error: failure, run: undefined }]);
    sleeping.calls[0]?.resume();
    await until(() => lookups === 2 && sleeping.calls.length === 2);
    expect(f.errors).toHaveLength(1);
  } finally {
    await f.daemon.stop();
    await running;
  }
});

test("failed activations back off from one second to the five second cap", async () => {
  const failure = new Error("Journal lookup failed. Restore storage.");

  class BrokenJournalStore extends MemoryRunStore {
    override async getSteps(): Promise<never> {
      throw failure;
    }
  }

  const sleeping = steppingSleeper();

  const f = fixture({
    store: new BrokenJournalStore(() => Date.parse(newRun().createdAt)),
    sleep: sleeping.sleep,
  });

  await f.store.createRun(newRun());
  const running = f.daemon.run();

  try {
    for (let index = 0; index < 4; index++) {
      await until(() => sleeping.calls.length === index + 1 && f.errors.length === index + 1);
      expect(sleeping.calls[index]?.milliseconds).toBe([1000, 2000, 4000, 5000][index]);
      expect(f.errors[index]?.error).toBe(failure);
      expect((await f.store.getRun("run"))?.owner).toBeUndefined();

      if (index < 3) {
        sleeping.calls[index]?.resume();
      }
    }
  } finally {
    await f.daemon.stop();
    await running;
  }
});

test("claim contention does not report an activation error", async () => {
  class ContendedStore extends MemoryRunStore {
    override async claim(runId: string): Promise<EngineRun> {
      throw new OwnershipError(runId);
    }
  }

  const f = fixture({ store: new ContendedStore() });
  await f.store.createRun(newRun());
  expect(await f.daemon.tick()).toEqual({ fired: 0, activated: 0 });
  expect(f.errors).toEqual([]);
});
