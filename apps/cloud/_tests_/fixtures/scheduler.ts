import { onTestFinished, setSystemTime } from "bun:test";
import { PAGE_LIMIT, type SavedLoopy } from "@loopy/contract";
import {
  type ExecutionKey,
  type Graph,
  type Json,
  revision,
  StorageError,
  type Store,
} from "@loopy/core";
import { DurableProviderError } from "@loopy/runtime/host";
import { RegistryError } from "@loopy/runtime/service";
import { SqlRunStore } from "@loopy/runtime/store/portable";
import { code, loopy } from "@loopy/sdk/graph";
import { Effect } from "effect";
import { withBundles } from "../../../../packages/runtime/_tests_/fixtures/compiled";
import { PolicyProvider } from "../../../../packages/runtime/_tests_/fixtures/host-policy";
import { BunSqlDriver } from "../../../../packages/runtime/src/store/bun-driver";
import type { R2ArtifactRegistry } from "../../src/artifacts";
import { SCHEDULER, type SchedulerStorage, WorkspaceScheduler } from "../../src/scheduler";

// The first instant at which another token's lease has expired.
export const expired = SCHEDULER.leaseMs + 1;

export const base = Date.parse("2026-10-22T12:00:00.000Z");

const workspace = "scheduler-test";

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

export function work(label = "work") {
  return code(label, { in: {}, out: { kind: "value", type: "number" }, module: "./work.ts" });
}

export function graph(name: string, run: Parameters<typeof loopy>[1]["run"] = () => work()) {
  return withBundles(loopy(name, { input: {}, run }));
}

export function fixture(concurrency = 3) {
  setSystemTime(base);
  const db = new BunSqlDriver(":memory:");

  onTestFinished(() => {
    setSystemTime();
    db.close();
  });

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
