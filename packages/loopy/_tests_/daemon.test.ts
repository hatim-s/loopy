import { expect, test } from "bun:test";
import type { DashboardReader } from "@loopy/contract";
import type { RunRecord, Schedule } from "@loopy/core";
import { makeDaemon, PreparationError, ScheduleRevisionError } from "@loopy/runtime/host";
import { loopy } from "@loopy/sdk/graph";
import type { Cause } from "effect";
import { Effect } from "effect";
import { TestClock } from "effect/testing";
import { FakeExecutor, newRun } from "./fixture";
import { countPasses, nextPass, waitUntil } from "./fixtures/service-runtime";
import { MemorySqlStore } from "./store-fixture";

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

for (const mode of ["due", "disabled", "stale", "minute-late"] as const) {
  test(`schedule ${mode} preserves startup and fire-key policy`, async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const base = Date.parse(newRun().createdAt);
          yield* TestClock.setTime(base);
          const store = new MemorySqlStore();
          const passes = countPasses(store);

          // The startup rule applies to the first pass, so the schedule exists before the loop starts.
          yield* store.putSchedule(
            schedule(
              mode === "disabled"
                ? { enabled: false }
                : mode === "stale"
                  ? { nextFireAt: new Date(base - 120_000).toISOString(), lastFireKey: "old" }
                  : mode === "minute-late"
                    ? { nextFireAt: new Date(base - 60_000).toISOString() }
                    : {},
            ),
          );

          const daemon = yield* makeDaemon({
            store,
            concurrency: 4,
            prepare: () => Effect.succeed({ graph, executor: new FakeExecutor() }),
            revisionFor: () => Effect.succeed("bundle"),
          });

          yield* Effect.forkScoped(daemon.run);

          // A minute-late slot fires at once and its successor at the current minute fires next.
          const fired = mode === "due" ? 1 : mode === "minute-late" ? 2 : 0;
          yield* settled(store, fired);
          yield* nextPass(daemon, passes);
          expect(yield* runs(store)).toHaveLength(fired);

          if (mode === "stale") {
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
          revisionFor: () => Effect.succeed("bundle"),
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

test("a failed schedule lookup reports once per pass and does not block a different schedule", async () => {
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
          revisionFor: (schedule) =>
            schedule.slug === "broken"
              ? Effect.fail(new ScheduleRevisionError({ cause: "Missing revision" }))
              : Effect.succeed("bundle"),
          onError: (cause) => {
            errors.push(cause);
          },
        });

        yield* store.putSchedule(schedule({ slug: "broken" }));
        yield* store.putSchedule(schedule());
        yield* Effect.forkScoped(daemon.run);
        yield* settled(store, 1);
        yield* nextPass(daemon, passes);
        expect(errors.length).toBe(passes());
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
          revisionFor: () => Effect.succeed("bundle"),
        });

        yield* store.createRun(newRun());
        yield* Effect.forkScoped(daemon.run);
        yield* settled(store, 1);
        expect((yield* store.getRun("run"))?.output).toEqual({ value: 42 });
        yield* nextPass(daemon, passes);
        expect(prunes).toBe(1);
        yield* TestClock.adjust(3_600_000);
        yield* nextPass(daemon, passes);
        expect(prunes).toBe(2);
      }),
    ).pipe(Effect.provide(TestClock.layer())),
  );
});
