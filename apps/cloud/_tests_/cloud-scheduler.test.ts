import { afterEach, expect, setSystemTime, test } from "bun:test";
import { PAGE_LIMIT, type SavedLoopy } from "@loopy/contract";
import {
  type ExecutionKey,
  type Graph,
  type Json,
  revision,
  StorageError,
  type Store,
} from "@loopy/core";
import { DurableProviderError, SCHEDULE_POLICY } from "@loopy/runtime/host";
import { RegistryError } from "@loopy/runtime/service";
import { SqlRunStore } from "@loopy/runtime/store/portable";
import { code, loopy, sleep, wait } from "@loopy/sdk";
import { Cause, Effect } from "effect";
import { withBundles } from "../../../packages/runtime/_tests_/fixtures/compiled";
import { PolicyProvider } from "../../../packages/runtime/_tests_/fixtures/host-policy";
import { BunSqlDriver } from "../../../packages/runtime/src/store/bun-driver";
import type { R2ArtifactRegistry } from "../src/artifacts";
import { SCHEDULER, type SchedulerStorage, WorkspaceScheduler } from "../src/scheduler";

// The first instant at which another token's lease has expired.
const expired = SCHEDULER.leaseMs + 1;

const base = Date.parse("2026-10-22T12:00:00.000Z");

const workspace = "scheduler-test";

const drivers: BunSqlDriver[] = [];

afterEach(() => {
  setSystemTime();

  for (const driver of drivers.splice(0)) {
    driver.close();
  }
});

class Storage implements SchedulerStorage {
  alarm: number | null = null;

  async getAlarm() {
    return this.alarm;
  }

  async setAlarm(at: Date | number) {
    this.alarm = Number(at);
  }

  async deleteAlarm() {
    this.alarm = null;
  }
}

class InterruptedStore extends SqlRunStore {
  releaseFailures = 0;
  fireFailures = new Map<string, "before" | "after">();

  override release(id: string, token: string) {
    return Effect.gen({ self: this }, function* () {
      if (this.releaseFailures > 0) {
        this.releaseFailures--;

        return yield* Effect.fail(
          new StorageError({
            operation: "release",
            reason: "unavailable",
            cause: new Error("Release interrupted after suspension committed."),
          }),
        );
      }

      return yield* this.baseRelease(id, token);
    });
  }
  private baseRelease(id: string, token: string) {
    return super.release(id, token);
  }

  override fireSchedule(options: Parameters<Store["fireSchedule"]>[0]) {
    return Effect.gen({ self: this }, function* () {
      const failure = this.fireFailures.get(options.schedule.slug);
      this.fireFailures.delete(options.schedule.slug);

      if (failure === "before") {
        return yield* Effect.fail(
          new StorageError({
            operation: "fire",
            reason: "unavailable",
            cause: new Error("Schedule transaction unavailable."),
          }),
        );
      }

      const fired = yield* this.baseFire(options);

      if (failure === "after") {
        return yield* Effect.fail(
          new StorageError({
            operation: "fire",
            reason: "unavailable",
            cause: new Error("Schedule commit response lost."),
          }),
        );
      }

      return fired;
    });
  }
  private baseFire(options: Parameters<Store["fireSchedule"]>[0]) {
    return super.fireSchedule(options);
  }
}

class Registry implements Pick<R2ArtifactRegistry, "get" | "revisionGraph"> {
  current = new Map<string, SavedLoopy>();
  graphs = new Map<string, Graph>();
  failures = new Set<string>();
  reads = new Map<string, number>();

  async save(graph: Graph) {
    const hash = await revision(graph);
    this.graphs.set(hash, graph);
    this.current.set(graph.name, {
      version: 3,
      slug: graph.name,
      graph,
      revision: hash,
      source: "/fixture.ts",
      savedAt: new Date().toISOString(),
      bundles: [],
    });

    return hash;
  }

  get(slug: string) {
    return Effect.try({
      try: () => {
        this.reads.set(slug, (this.reads.get(slug) ?? 0) + 1);

        if (this.failures.has(slug)) {
          throw new Error(`Registry unavailable. ${"x".repeat(2000)}`);
        }

        return this.current.get(slug) ?? null;
      },
      catch: (cause) => new RegistryError({ operation: "get", cause }),
    });
  }

  revisionGraph(hash: string) {
    return Effect.try({
      try: () => {
        const graph = this.graphs.get(hash);

        if (!graph) {
          throw new Error(`Missing fixture revision ${hash}.`);
        }

        return graph;
      },
      catch: (cause) => new RegistryError({ operation: "revisionGraph", cause }),
    });
  }
}

/** Also records how many executions the store holds as running at each start. */
class Provider extends PolicyProvider {
  runningCounts: number[] = [];

  constructor(private readonly store: SqlRunStore) {
    super();
  }

  override start(key: ExecutionKey, attempt: number) {
    return this.store.runningCount().pipe(
      Effect.mapError(
        (cause) =>
          new DurableProviderError({
            operation: "start",
            reason: "transport",
            message: "Fixture storage unavailable",
            cause,
          }),
      ),
      Effect.tap((count) => Effect.sync(() => this.runningCounts.push(count))),
      Effect.andThen(super.start(key, attempt)),
    );
  }
}

function work(label = "work") {
  return code(label, { in: {}, out: { kind: "value", type: "number" }, module: "./work.ts" });
}

function graph(name: string, run: Parameters<typeof loopy>[1]["run"] = () => work()) {
  return withBundles(loopy(name, { input: {}, run }));
}

function fixture(concurrency = 3) {
  setSystemTime(base);
  const db = new BunSqlDriver(":memory:");
  drivers.push(db);

  const store = new InterruptedStore(db, {
    leaseMs: SCHEDULER.leaseMs,
    owner: { identity: { pid: null, host: "fixture" }, isAlive: () => false },
  });

  const storage = new Storage();
  let schedulerError: string | null = null;

  const failures = {
    read: () => schedulerError,
    write: (error: string) => {
      schedulerError = error;
    },
  };

  const registry = new Registry();
  const provider = new Provider(store);

  const scheduler = (token = "original") =>
    new WorkspaceScheduler({ storage, failures, store, registry, provider, token, concurrency });

  return {
    db,
    store,
    storage,
    registry,
    provider,
    scheduler,
    at: (ms: number) => setSystemTime(base + ms),
    turnErrors: () => Effect.runPromise(store.turnErrors(100)),
    scheduleFailures: () => Effect.runPromise(store.scheduleFailures(100)),
    schedulerError: () => schedulerError,
    runs: (slug: string) =>
      Effect.runPromise(
        store.queryRuns({ slug, limit: PAGE_LIMIT, now: new Date().toISOString() }),
      ),
    async run(id: string, graph: Graph, input: Json = {}) {
      await Effect.runPromise(
        store.createRun({
          id,
          slug: graph.name,
          revision: await registry.save(graph),
          workspace,
          input,
          status: "queued",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
      );
    },
    async schedule(graph: Graph, input: Json = {}) {
      await registry.save(graph);

      return Effect.runPromise(
        store.putSchedule({
          workspace,
          slug: graph.name,
          cron: "* * * * *",
          tz: "UTC",
          input,
          enabled: true,
          nextFireAt: new Date(base).toISOString(),
        }),
      );
    },
  };
}

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

test("invalid input, absent definitions and registry failures isolate schedules and recover", async () => {
  const f = fixture();
  await f.run("running", graph("running"));
  await Effect.runPromise(f.scheduler().tick());
  f.provider.finishAll();
  const failedAt = 500;
  f.at(failedAt);
  await f.run("queued", graph("queued"));
  await f.schedule(graph("invalid"));
  const changed = graph("invalid");
  changed.input = { required: "string" };
  await f.registry.save(changed);
  await f.schedule(graph("transient"));
  f.registry.failures.add("transient");
  await f.schedule(graph("missing"));
  f.registry.current.delete("missing");
  await f.schedule(graph("healthy"));
  await Effect.runPromise(f.scheduler().tick());
  expect((await Effect.runPromise(f.store.getRun("running")))?.status).toBe("succeeded");
  expect((await Effect.runPromise(f.store.getRun("queued")))?.status).toBe("running");
  expect(await f.runs("healthy")).toMatchObject([{ status: "running" }]);
  expect(
    (await Effect.runPromise(f.store.listSchedules())).find((s) => s.slug === "invalid")?.enabled,
  ).toBe(false);
  const failures = new Map((await f.scheduleFailures()).map((failure) => [failure.slug, failure]));

  expect(failures.get("invalid")).toMatchObject({
    retryAt: null,
    error:
      "Schedule disabled because the saved input no longer matches the current graph: Input does not match the saved graph schema.",
  });

  const retry = failures.get("transient");
  const retryAt = failedAt + SCHEDULE_POLICY.retryMs;
  expect(retry?.retryAt).toBe(new Date(base + retryAt).toISOString());
  expect(retry?.error).toStartWith("Could not get. Registry unavailable.");
  expect(retry?.error.length).toBe(SCHEDULE_POLICY.errorChars);
  expect(await f.runs("missing")).toEqual([]);
  expect(
    (await Effect.runPromise(f.store.listSchedules())).find((s) => s.slug === "missing")?.enabled,
  ).toBe(true);
  expect(failures.get("missing")).toMatchObject({
    retryAt: new Date(base + retryAt).toISOString(),
    error: "No saved loopy 'missing'. Use loopy save <file.ts> first.",
  });
  expect(f.schedulerError()).toBeNull();
  f.at(1000);
  f.provider.finishAll();
  await Effect.runPromise(f.scheduler("original").tick());
  expect(f.registry.reads.get("transient")).toBe(1);
  expect(f.registry.reads.get("missing")).toBe(1);
  expect(f.storage.alarm).toBe(base + retryAt);
  f.registry.failures.clear();
  const restored = graph("missing", () => work("restored"));
  const restoredRevision = await f.registry.save(restored);
  f.at(retryAt);
  await Effect.runPromise(f.scheduler().tick());
  expect(await f.runs("transient")).toHaveLength(1);
  expect(await f.runs("healthy")).toHaveLength(1);
  expect((await f.scheduleFailures()).map((failure) => failure.slug)).toEqual(["invalid"]);
  expect((await f.runs("transient"))[0]?.status).toBe("running");
  expect(await f.runs("missing")).toMatchObject([
    { status: "running", revision: restoredRevision },
  ]);
  await f.registry.save(graph("missing", () => work("later")));
  expect((await f.runs("missing"))[0]?.revision).toBe(restoredRevision);
});

for (const failure of ["before", "after"] as const) {
  test(`schedule fire failure ${failure} commit is bounded and does not duplicate a fire`, async () => {
    const f = fixture();
    await f.schedule(graph("broken"));
    await f.schedule(graph("healthy"));
    f.store.fireFailures.set("broken", failure);
    await Effect.runPromise(f.scheduler().tick());
    expect(await f.runs("healthy")).toMatchObject([{ status: "running" }]);
    expect(await f.runs("broken")).toHaveLength(failure === "before" ? 0 : 1);
    expect(await f.scheduleFailures()).toMatchObject([
      {
        slug: "broken",
        error:
          failure === "before"
            ? "Storage operation 'fire' failed: Schedule transaction unavailable."
            : "Storage operation 'fire' failed: Schedule commit response lost.",
      },
    ]);
    f.provider.finishAll();
    f.at(500);
    await Effect.runPromise(f.scheduler().tick());
    expect(f.registry.reads.get("broken")).toBe(1);
    // A failed fire retries after the policy delay; a committed one waits for the next minute.
    expect(f.storage.alarm).toBe(base + (failure === "before" ? SCHEDULE_POLICY.retryMs : 60_000));
    f.at(SCHEDULE_POLICY.retryMs);
    await Effect.runPromise(f.scheduler().tick());
    expect(await f.runs("broken")).toHaveLength(1);
    expect(await f.runs("healthy")).toHaveLength(1);
  });
}

test("a full failing schedule batch yields to later schedules on the next alarm", async () => {
  const f = fixture();

  for (let index = 0; index < SCHEDULE_POLICY.batch; index++) {
    const slug = `broken-${String(index).padStart(2, "0")}`;
    await f.schedule(graph(slug));
    f.registry.failures.add(slug);
  }

  await f.schedule(graph("healthy"));
  await f.run("queued", graph("queued"));
  await Effect.runPromise(f.scheduler().tick());
  expect((await Effect.runPromise(f.store.getRun("queued")))?.status).toBe("running");
  expect(await f.runs("healthy")).toEqual([]);
  expect(f.storage.alarm).toBe(base + SCHEDULER.alarmFloorMs);
  f.at(SCHEDULER.alarmFloorMs);
  await Effect.runPromise(f.scheduler().tick());
  expect(await f.runs("healthy")).toMatchObject([{ status: "running" }]);
  expect(f.registry.reads.get("broken-00")).toBe(1);
  // The queued run polls on the interval counted from its first turn.
  expect(f.storage.alarm).toBe(base + SCHEDULER.pollMs);
});

test("scheduler isolates provider and schedule defects and retains recovery alarms", async () => {
  const f = fixture();
  const broken = graph("broken");
  const healthy = graph("healthy");
  await f.run("broken", broken);
  await f.run("healthy", healthy);
  const lookup = f.provider.lookup.bind(f.provider);
  f.provider.lookup = (key, attempt) =>
    key.runId === "broken" ? Effect.die(new Error("provider defect")) : lookup(key, attempt);
  await Effect.runPromise(f.scheduler().tick());
  expect(await Effect.runPromise(f.store.getRun("healthy"))).toMatchObject({ status: "running" });
  expect(await f.turnErrors()).toEqual([{ runId: "broken", error: "provider defect" }]);
  await f.schedule(graph("broken-schedule"));
  await f.schedule(graph("healthy-schedule"));
  const get = f.registry.get.bind(f.registry);
  f.registry.get = (slug) =>
    slug === "broken-schedule" ? Effect.die(new Error("schedule defect")) : get(slug);
  await Effect.runPromise(f.scheduler().tick());
  expect(await f.runs("healthy-schedule")).toHaveLength(1);
  expect(await f.scheduleFailures()).toMatchObject([
    { slug: "broken-schedule", error: "schedule defect" },
  ]);
  f.store.pruneEvents = () => Effect.die(new Error("prune defect"));
  await Effect.runPromise(f.scheduler().tick());
  expect(f.schedulerError()).toBe("prune defect");
  expect(f.storage.alarm).toBe(base + SCHEDULER.recoveryMs);
});

test("scheduler interruption preserves the recovery alarm without recording a failure", async () => {
  const f = fixture();
  await f.run("interrupted", graph("interrupted"));
  f.provider.lookup = () => Effect.interrupt;
  const exit = await Effect.runPromiseExit(f.scheduler().tick());
  expect(exit._tag).toBe("Failure");

  if (exit._tag === "Failure") {
    expect(Cause.hasInterrupts(exit.cause)).toBe(true);
  }

  expect(f.storage.alarm).toBe(base + SCHEDULER.recoveryMs);
  expect(f.schedulerError()).toBeNull();
});
