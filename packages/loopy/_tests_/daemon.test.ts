import { expect, test } from "bun:test";
import { type RunRecord, type Schedule } from "@loopy/core";
import { makeDaemon, PreparationError, ScheduleRevisionError } from "@loopy/runtime/host";
import { MemoryStore } from "@loopy/runtime/store";
import { loopy } from "@loopy/sdk/graph";
import type { Cause } from "effect";
import { Effect } from "effect";
import { TestClock } from "effect/testing";
import { FakeExecutor, newRun } from "./fixture";

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

for (const mode of ["due", "disabled", "stale", "minute-late"] as const) {
  test(`schedule ${mode} preserves startup and fire-key policy`, async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const base = Date.parse(newRun().createdAt);
          yield* TestClock.setTime(base);
          let now = base;
          const store = new MemoryStore(() => now);

          const daemon = yield* makeDaemon({
            store,
            concurrency: 4,
            prepare: () => Effect.succeed({ graph, executor: new FakeExecutor() }),
            revisionFor: () => Effect.succeed("bundle"),
          });

          const expected = mode === "due" || mode === "minute-late" ? 1 : 0;
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
          expect(yield* daemon.tick).toEqual({ fired: expected, activated: expected });
          expect(yield* daemon.tick).toEqual({
            fired: mode === "minute-late" ? 1 : 0,
            activated: mode === "minute-late" ? 1 : 0,
          });
          expect(yield* store.listRuns()).toHaveLength(expected + (mode === "minute-late" ? 1 : 0));

          if (mode === "stale") {
            expect((yield* store.listSchedules())[0]).toMatchObject({
              lastFireKey: "old",
              nextFireAt: new Date(base + 60_000).toISOString(),
            });
          }

          now += 60_000;
          yield* TestClock.adjust(60_000);
          expect(yield* daemon.tick).toEqual({
            fired: mode === "disabled" ? 0 : 1,
            activated: mode === "disabled" ? 0 : 1,
          });
        }),
      ).pipe(Effect.provide(TestClock.layer())),
    );
  });
}

test("preparation failure finishes that run, reports its Cause and permits other work", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const store = new MemoryStore();
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
        expect(yield* daemon.tick).toEqual({ fired: 0, activated: 2 });
        expect(yield* store.getRun("run")).toMatchObject({
          status: "failed",
          error: "Missing revision",
        });
        expect((yield* store.getRun("run"))?.owner).toBeUndefined();
        expect((yield* store.getRun("second"))?.status).toBe("succeeded");
        expect(errors[0]?.run?.id).toBe("run");
      }),
    ),
  );
});

test("a failed schedule lookup reports once and does not block a different schedule", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(newRun().createdAt));
        const store = new MemoryStore(() => Date.parse(newRun().createdAt));
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
        expect(yield* daemon.tick).toEqual({ fired: 1, activated: 1 });
        expect(errors).toHaveLength(1);
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

        class RecordingStore extends MemoryStore {
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

        const daemon = yield* makeDaemon({
          store,
          concurrency: 1,
          prepare: () => Effect.succeed({ graph, executor: new FakeExecutor() }),
          revisionFor: () => Effect.succeed("bundle"),
        });

        yield* store.createRun(newRun());
        expect(yield* daemon.tick).toEqual({ fired: 0, activated: 1 });
        expect((yield* store.getRun("run"))?.output).toEqual({ value: 42 });
        yield* daemon.tick;
        expect(prunes).toBe(1);
        yield* TestClock.adjust(3_600_000);
        yield* daemon.tick;
        expect(prunes).toBe(2);
      }),
    ).pipe(Effect.provide(TestClock.layer())),
  );
});
