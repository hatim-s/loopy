import { expect, test } from "bun:test";
import type { DashboardReader } from "@loopy/contract";
import type { RunRecord, Schedule } from "@loopy/core";
import { loopy } from "@loopy/sdk/graph";
import type { Cause } from "effect";
import { Effect } from "effect";
import { TestClock } from "effect/testing";
import { FakeExecutor, newRun } from "../../core/_tests_/fixtures/run";
import { makeDaemon, PreparationError, ScheduleDefinitionError } from "../src/host";
import { countPasses, nextPass, waitUntil } from "./fixtures/service-runtime";
import { MemorySqlStore } from "./fixtures/stores";

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

const graph = loopy("test", {
  input: { "value?": "number", "scheduled?": "boolean" },
  run: ({ input }) => input,
});

const runs = (store: Pick<DashboardReader, "queryRuns">) =>
  store.queryRuns({ limit: 200, now: newRun().createdAt });

const settled = (store: Pick<DashboardReader, "queryRuns">, count: number) =>
  waitUntil(
    Effect.map(
      runs(store),
      (all) => all.length === count && all.every((run) => run.status === "succeeded"),
    ),
  );

// A slot up to a minute late fires once as now; a later one is skipped without a run.
for (const mode of ["due", "disabled", "missed", "minute-late"] as const) {
  test(`schedule ${mode} slot fires at most once and resumes on the next slot`, async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const base = Date.parse(newRun().createdAt);
          yield* TestClock.setTime(base);
          const store = new MemorySqlStore();
          const passes = countPasses(store);

          yield* store.putSchedule(
            schedule(
              mode === "disabled"
                ? { enabled: false }
                : mode === "missed"
                  ? { nextFireAt: new Date(base - 61_000).toISOString(), lastFireKey: "old" }
                  : mode === "minute-late"
                    ? { nextFireAt: new Date(base - 60_000).toISOString() }
                    : {},
            ),
          );

          const daemon = yield* makeDaemon({
            store,
            concurrency: 4,
            prepare: () => Effect.succeed({ graph, executor: new FakeExecutor() }),
            definitionFor: () => Effect.succeed({ revision: "bundle", graph }),
          });

          yield* Effect.forkScoped(daemon.run);

          const fired = mode === "disabled" || mode === "missed" ? 0 : 1;
          yield* settled(store, fired);
          yield* nextPass(daemon, passes);
          expect(yield* runs(store)).toHaveLength(fired);

          if (mode === "missed") {
            expect((yield* store.listSchedules())[0]).toMatchObject({
              lastFireKey: "old",
              nextFireAt: new Date(base + 60_000).toISOString(),
            });
          }

          yield* TestClock.adjust(60_000);
          const later = fired + (mode === "disabled" ? 0 : 1);
          yield* settled(store, later);
          yield* nextPass(daemon, passes);
          expect(yield* runs(store)).toHaveLength(later);
        }),
      ).pipe(Effect.provide(TestClock.layer())),
    );
  });
}

test("preparation failure finishes that run, reports its Cause and permits other work", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const store = new MemorySqlStore();
        const errors: { cause: Cause.Cause<unknown>; run?: RunRecord }[] = [];

        const daemon = yield* makeDaemon({
          store,
          concurrency: 2,
          prepare: (run) =>
            run.id === "run"
              ? Effect.fail(new PreparationError({ cause: "Missing revision" }))
              : Effect.succeed({ graph, executor: new FakeExecutor() }),
          definitionFor: () => Effect.succeed({ revision: "bundle", graph }),
          onError: (cause, run) => {
            errors.push({ cause, run });
          },
        });

        yield* store.createRun(newRun());
        yield* store.createRun({ ...newRun(), id: "second" });
        yield* Effect.forkScoped(daemon.run);
        yield* waitUntil(
          Effect.map(runs(store), (all) =>
            all.every((run) => run.status !== "queued" && !run.owner),
          ),
        );
        expect(yield* store.getRun("run")).toMatchObject({
          status: "failed",
          error: "Missing revision",
        });
        expect((yield* store.getRun("run"))?.owner).toBeUndefined();
        expect((yield* store.getRun("second"))?.status).toBe("succeeded");
        expect(errors.map((error) => error.run?.id)).toEqual(["run"]);
      }),
    ),
  );
});

test("a failed schedule lookup waits for its retry deadline without blocking another schedule", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(newRun().createdAt));
        const store = new MemorySqlStore();
        const passes = countPasses(store);
        const errors: Cause.Cause<unknown>[] = [];

        const daemon = yield* makeDaemon({
          store,
          concurrency: 2,
          prepare: () => Effect.succeed({ graph, executor: new FakeExecutor() }),
          definitionFor: (schedule) =>
            schedule.slug === "broken"
              ? Effect.fail(new ScheduleDefinitionError({ cause: "Missing revision" }))
              : Effect.succeed({ revision: "bundle", graph }),
          onError: (cause) => {
            errors.push(cause);
          },
        });

        yield* store.putSchedule(schedule({ slug: "broken" }));
        yield* store.putSchedule(schedule());
        yield* Effect.forkScoped(daemon.run);
        yield* settled(store, 1);
        yield* nextPass(daemon, passes);
        expect(errors).toHaveLength(1);
        expect(yield* store.scheduleFailures(10)).toEqual([
          {
            workspace: "/workspace",
            slug: "broken",
            error: "Missing revision",
            retryAt: new Date(Date.parse(newRun().createdAt) + 5000).toISOString(),
          },
        ]);
      }),
    ).pipe(Effect.provide(TestClock.layer())),
  );
});

test("queued runs activate and prune runs at startup and hourly", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const base = Date.parse(newRun().createdAt);
        yield* TestClock.setTime(base);
        let prunes = 0;

        class RecordingStore extends MemorySqlStore {
          override pruneEvents(at: string) {
            return super.pruneEvents(at).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  prunes++;
                }),
              ),
            );
          }
        }

        const store = new RecordingStore();
        const passes = countPasses(store);

        const daemon = yield* makeDaemon({
          store,
          concurrency: 1,
          prepare: () => Effect.succeed({ graph, executor: new FakeExecutor() }),
          definitionFor: () => Effect.succeed({ revision: "bundle", graph }),
        });

        yield* store.createRun(newRun());
        yield* Effect.forkScoped(daemon.run);
        yield* settled(store, 1);
        expect(yield* store.getRun("run")).toMatchObject({ output: { value: 42 } });
        yield* nextPass(daemon, passes);
        expect(prunes).toBe(1);
        yield* TestClock.adjust(3_600_000);
        yield* nextPass(daemon, passes);
        expect(prunes).toBe(2);
      }),
    ).pipe(Effect.provide(TestClock.layer())),
  );
});
