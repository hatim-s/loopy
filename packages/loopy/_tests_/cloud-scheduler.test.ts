import { afterEach, expect, setSystemTime, test } from "bun:test";
import type { R2ArtifactRegistry } from "../../../apps/cloud/src/artifacts.js";
import { type SchedulerStorage, WorkspaceScheduler } from "../../../apps/cloud/src/scheduler.js";
import type { SavedLoopy } from "../src/contract/index.js";
import {
  type ExecutionKey,
  executionKeyString,
  type Graph,
  type Json,
  type Receipt,
  revision,
  type Store,
} from "../src/core/index.js";
import type { DurableExecutionProvider } from "../src/host/index.js";
import { code, loopy, sleep, wait } from "../src/sdk/graph/index.js";
import { SqlRunStore, type SqlValue } from "../src/store/portable.js";
import { BunSqlDriver } from "../src/store/sqlite/bun-driver.js";

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
  readonly sql;

  constructor(db: BunSqlDriver) {
    this.sql = {
      exec<Row extends Record<string, SqlValue>>(query: string, ...bindings: SqlValue[]) {
        const rows = db.query<Row>(query).all(...bindings);

        return {
          toArray: () => rows,
          one: () => {
            if (rows.length !== 1 || !rows[0]) {
              throw new Error("Expected exactly one SQL row.");
            }

            return rows[0];
          },
        };
      },
    };
  }

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

  override async release(id: string, token: string) {
    if (this.releaseFailures > 0) {
      this.releaseFailures--;
      throw new Error("Release interrupted after suspension committed.");
    }

    return super.release(id, token);
  }

  override async fireSchedule(options: Parameters<Store["fireSchedule"]>[0]) {
    const failure = this.fireFailures.get(options.slug);
    this.fireFailures.delete(options.slug);

    if (failure === "before") {
      throw new Error("Schedule transaction unavailable.");
    }

    const fired = await super.fireSchedule(options);

    if (failure === "after") {
      throw new Error("Schedule commit response lost.");
    }

    return fired;
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
      version: 2,
      slug: graph.name,
      graph,
      revision: hash,
      source: "/fixture.ts",
      savedAt: new Date().toISOString(),
      ...graph.meta,
      input: graph.input,
      bundles: [],
    });

    return hash;
  }

  async get(slug: string) {
    this.reads.set(slug, (this.reads.get(slug) ?? 0) + 1);

    if (this.failures.has(slug)) {
      throw new Error(`Registry unavailable. ${"x".repeat(2000)}`);
    }

    const saved = this.current.get(slug);

    if (!saved) {
      throw new Error(`Missing fixture definition ${slug}.`);
    }

    return saved;
  }

  async revisionGraph(hash: string) {
    const graph = this.graphs.get(hash);

    if (!graph) {
      throw new Error(`Missing fixture revision ${hash}.`);
    }

    return graph;
  }
}

class Provider implements DurableExecutionProvider {
  receipts = new Map<string, Receipt>();
  starts: string[] = [];
  runningCounts: number[] = [];
  result: Receipt = { kind: "started" };

  constructor(private readonly store: SqlRunStore) {}

  async lookup(key: ExecutionKey, attempt: number): Promise<Receipt> {
    return this.receipts.get(`${executionKeyString(key)}/${attempt}`) ?? { kind: "none" };
  }

  async start(key: ExecutionKey, attempt: number) {
    const id = `${executionKeyString(key)}/${attempt}`;
    this.starts.push(id);
    this.runningCounts.push((await this.store.listRuns({ status: "running" })).length);
    this.receipts.set(id, this.result);

    return this.result;
  }

  finishAll() {
    for (const id of this.starts) {
      this.receipts.set(id, {
        kind: "finished",
        result: { kind: "succeeded", output: 1, logs: [] },
      });
    }
  }
}

function work(label = "work") {
  return code(label, { in: {}, out: { kind: "value", type: "number" }, module: "./work.ts" });
}

function graph(name: string, run: Parameters<typeof loopy>[1]["run"] = () => work()) {
  const graph = loopy(name, { input: {}, run }).graph;

  for (const node of graph.nodes) {
    if (node.kind === "code") {
      node.module.bundleHash = "a".repeat(64);
    }
  }

  return graph;
}

function fixture(concurrency = 3) {
  setSystemTime(base);
  const db = new BunSqlDriver(":memory:");
  drivers.push(db);

  const store = new InterruptedStore(db, {
    now: () => Date.now(),
    leaseMs: 10_000,
    owner: { identity: { pid: null, host: "fixture" }, isAlive: () => false },
  });

  const storage = new Storage(db);
  const registry = new Registry();
  const provider = new Provider(store);

  const scheduler = (token = "original") =>
    new WorkspaceScheduler({ storage, store, registry, provider, token, concurrency, workspace });

  return {
    db,
    store,
    storage,
    registry,
    provider,
    scheduler,
    at: (ms: number) => setSystemTime(base + ms),
    async run(id: string, graph: Graph, input: Json = {}) {
      await store.createRun({
        id,
        slug: graph.name,
        revision: await registry.save(graph),
        workspace,
        input,
        status: "queued",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    },
    async schedule(graph: Graph, input: Json = {}) {
      await registry.save(graph);

      return store.putSchedule({
        workspace,
        slug: graph.name,
        cron: "* * * * *",
        tz: "UTC",
        input,
        enabled: true,
        nextFireAt: new Date(base).toISOString(),
      });
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
      await f.scheduler().tick();
      expect(await f.store.getRun("paused")).toMatchObject({
        status: "suspended",
        owner: { token: "original" },
      });
      expect(f.storage.alarm).toBe(base + 1000);
      expect(f.db.query("SELECT error FROM cloud_turns").get()).toEqual({
        error: "Release interrupted after suspension committed.",
      });

      const scheduler = f.scheduler(owner === "same token" ? "original" : "replacement");
      f.at(owner === "expired foreign" ? 10_001 : 1000);
      await scheduler.tick();

      if (owner === "fresh foreign") {
        expect((await f.store.getRun("paused"))?.owner?.token).toBe("original");
        expect(f.storage.alarm).toBe(base + 10_001);
        f.at(10_000);
        await scheduler.tick();
        expect((await f.store.getRun("paused"))?.owner?.token).toBe("original");
        f.at(10_001);
        await scheduler.tick();
      }

      expect((await f.store.getRun("paused"))?.owner).toBeUndefined();
      expect(f.provider.starts).toHaveLength(1);

      if (waiting === "indefinite wait") {
        expect((await f.store.getRun("paused"))?.status).toBe("suspended");
        expect(await f.store.getWaits("paused")).toHaveLength(1);
        expect(f.storage.alarm).toBeNull();
        f.at(120_000);
        await scheduler.tick();
        expect((await f.store.getRun("paused"))?.status).toBe("suspended");
        expect(await f.store.getWaits("paused")).toHaveLength(1);
        expect(f.provider.starts).toHaveLength(1);
        expect(f.storage.alarm).toBeNull();
      } else {
        if (waiting === "future sleep") {
          expect(await f.store.getRun("paused")).toMatchObject({
            status: "suspended",
            wakeAt: new Date(base + 60_000).toISOString(),
          });
          expect(f.storage.alarm).toBe(base + 60_000);
          f.at(60_000);
          await scheduler.tick();
        }

        expect((await f.store.getRun("paused"))?.status).toBe("succeeded");
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
  await f.scheduler().tick();
  expect(f.storage.alarm).toBe(base + 60_000);
  const hook = (await f.store.getWaits("approval"))[0];

  if (!hook) {
    throw new Error("Expected a persisted hook.");
  }

  f.at(1000);
  expect(
    await f.store.resolveWait({ token: hook.token, payload: true, at: new Date().toISOString() }),
  ).toMatchObject({ kind: "resolved" });
  await f.scheduler().tick();
  expect((await f.store.getRun("approval"))?.status).toBe("succeeded");
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
  await scheduler.tick();
  f.at(1000);
  await scheduler.tick();
  expect(f.storage.alarm).toBe(base + 2000);
  expect((await f.store.getRun("paused"))?.owner?.token).toBe("original");
  f.at(1500);
  await scheduler.tick();
  expect((await f.store.getRun("paused"))?.owner?.token).toBe("original");
  expect(f.storage.alarm).toBe(base + 2000);
  f.at(2000);
  await scheduler.tick();
  expect((await f.store.getRun("paused"))?.owner).toBeUndefined();
  expect(await f.store.getWaits("paused")).toHaveLength(1);
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
  await f.scheduler().tick();
  await f.run("blocker", graph("blocker"));
  await f.scheduler().tick();
  expect(f.provider.starts).toHaveLength(1);
  f.at(10_001);
  const scheduler = f.scheduler("replacement");
  await scheduler.tick();
  expect(await f.store.getRun("paused")).toMatchObject({
    status: "suspended",
    wakeAt: new Date(base + 1000).toISOString(),
  });
  expect((await f.store.getRun("paused"))?.owner).toBeUndefined();
  expect(f.provider.starts).toHaveLength(1);
  expect(f.storage.alarm).toBe(base + 10_501);
  f.provider.finishAll();
  f.at(10_501);
  await scheduler.tick();
  f.at(10_551);
  await scheduler.tick();
  expect((await f.store.getRun("paused"))?.status).toBe("running");
  expect(f.provider.starts).toHaveLength(2);
  expect(f.provider.runningCounts).toEqual([1, 1]);
});

test("invalid revised input and transient registry failure do not stop healthy schedules or runs", async () => {
  const f = fixture();
  await f.run("running", graph("running"));
  await f.scheduler().tick();
  f.provider.finishAll();
  f.at(500);
  await f.run("queued", graph("queued"));
  await f.schedule(graph("invalid"));
  const changed = graph("invalid");
  changed.input = { required: "string" };
  await f.registry.save(changed);
  await f.schedule(graph("transient"));
  f.registry.failures.add("transient");
  await f.schedule(graph("healthy"));
  await f.scheduler().tick();
  expect((await f.store.getRun("running"))?.status).toBe("succeeded");
  expect((await f.store.getRun("queued"))?.status).toBe("running");
  expect(await f.store.listRuns({ slug: "healthy" })).toMatchObject([{ status: "running" }]);
  expect((await f.store.listSchedules()).find((s) => s.slug === "invalid")?.enabled).toBe(false);
  expect(
    f.db
      .query<{ value: string }, []>("SELECT value FROM meta WHERE key='schedule_error:invalid'")
      .get()?.value,
  ).toBe(
    "Schedule disabled because the saved input no longer matches the current graph: Input does not match the saved graph schema.",
  );

  const retry = f.db
    .query<{ next_at: string; error: string }, []>(
      "SELECT next_at,error FROM cloud_schedule_turns WHERE slug='transient'",
    )
    .get();

  expect(retry?.next_at).toBe(new Date(base + 5500).toISOString());
  expect(retry?.error).toStartWith("Registry unavailable.");
  expect(retry?.error.length).toBe(1000);
  expect(f.db.query("SELECT value FROM meta WHERE key='cloud_scheduler_error'").get()).toBeNull();
  f.at(1000);
  f.provider.finishAll();
  await f.scheduler("original").tick();
  expect(f.registry.reads.get("transient")).toBe(1);
  expect(f.storage.alarm).toBe(base + 5500);
  f.registry.failures.clear();
  f.at(5500);
  await f.scheduler().tick();
  expect(await f.store.listRuns({ slug: "transient" })).toHaveLength(1);
  expect(await f.store.listRuns({ slug: "healthy" })).toHaveLength(1);
  expect(f.db.query("SELECT * FROM cloud_schedule_turns").all()).toEqual([]);
  expect((await f.store.listRuns({ slug: "transient" }))[0]?.status).toBe("running");
});

for (const failure of ["before", "after"] as const) {
  test(`schedule fire failure ${failure} commit is bounded and does not duplicate a fire`, async () => {
    const f = fixture();
    await f.schedule(graph("broken"));
    await f.schedule(graph("healthy"));
    f.store.fireFailures.set("broken", failure);
    await f.scheduler().tick();
    expect(await f.store.listRuns({ slug: "healthy" })).toMatchObject([{ status: "running" }]);
    expect(await f.store.listRuns({ slug: "broken" })).toHaveLength(failure === "before" ? 0 : 1);
    expect(f.db.query("SELECT error FROM cloud_schedule_turns").get()).toEqual({
      error:
        failure === "before"
          ? "Schedule transaction unavailable."
          : "Schedule commit response lost.",
    });
    f.provider.finishAll();
    f.at(500);
    await f.scheduler().tick();
    expect(f.registry.reads.get("broken")).toBe(1);
    expect(f.storage.alarm).toBe(base + (failure === "before" ? 5000 : 60_000));
    f.at(5000);
    await f.scheduler().tick();
    expect(await f.store.listRuns({ slug: "broken" })).toHaveLength(1);
    expect(await f.store.listRuns({ slug: "healthy" })).toHaveLength(1);
  });
}

test("a full failing schedule batch yields to later schedules on the next alarm", async () => {
  const f = fixture();

  for (let index = 0; index < 32; index++) {
    const slug = `broken-${String(index).padStart(2, "0")}`;
    await f.schedule(graph(slug));
    f.registry.failures.add(slug);
  }

  await f.schedule(graph("healthy"));
  await f.run("queued", graph("queued"));
  await f.scheduler().tick();
  expect((await f.store.getRun("queued"))?.status).toBe("running");
  expect(await f.store.listRuns({ slug: "healthy" })).toEqual([]);
  expect(f.storage.alarm).toBe(base + 50);
  f.at(50);
  await f.scheduler().tick();
  expect(await f.store.listRuns({ slug: "healthy" })).toMatchObject([{ status: "running" }]);
  expect(f.registry.reads.get("broken-00")).toBe(1);
  expect(f.storage.alarm).toBe(base + 500);
});
