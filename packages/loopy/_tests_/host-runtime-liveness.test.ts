import { expect, test } from "bun:test";
import { type Executor, OwnershipError, StorageError } from "@loopy/core";
import {
  DriverCleanupFailed,
  LeaseReleaseUnknown,
  makeDaemon,
  PreparationError,
  ScheduleDefinitionError,
} from "@loopy/runtime/host";
import { loopy, sh } from "@loopy/sdk/graph";
import { Cause, Deferred, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { FakeExecutor, newRun } from "./fixture";
import { countPasses, nextPass, waitUntil } from "./fixtures/service-runtime";
import { MemorySqlStore } from "./store-fixture";

const graph = loopy("test", { input: {}, run: () => sh(["true"]) });

const empty = loopy("test", { input: {}, run: () => 42 });

const base = Date.parse(newRun().createdAt);

function schedule(slug = "test") {
  return {
    workspace: "/workspace",
    slug,
    cron: "* * * * *",
    tz: "UTC",
    input: {},
    enabled: true,
    nextFireAt: newRun().createdAt,
  };
}

test("a held activation leaves background schedule and run admission live", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(base);
        const held = yield* Deferred.make<void>();
        const entered = yield* Deferred.make<void>();
        const completed = yield* Deferred.make<void>();
        let finishes = 0;

        class RecordingStore extends MemorySqlStore {
          override apply(batch: Parameters<MemorySqlStore["apply"]>[0]) {
            return super.apply(batch).pipe(
              Effect.tap(() => {
                if (
                  batch.runId !== "held" &&
                  batch.effects.some((effect) => effect.kind === "finish_run")
                ) {
                  finishes++;

                  if (finishes === 2) {
                    return Deferred.succeed(completed, undefined);
                  }
                }

                return Effect.void;
              }),
            );
          }
        }

        const store = new RecordingStore();

        const executor: Executor = {
          lookup: () => Effect.succeed({ kind: "none" }),
          execute: (key) =>
            (key.runId === "held"
              ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(held)))
              : Effect.void
            ).pipe(
              Effect.as({
                kind: "succeeded",
                output: { stdout: "", stderr: "", exitCode: 0 },
                logs: [],
              }),
            ),
        };

        const daemon = yield* makeDaemon({
          store,
          concurrency: 2,
          prepare: () => Effect.succeed({ graph, executor }),
          definitionFor: () => Effect.succeed({ revision: "bundle", graph }),
        });

        yield* store.createRun({ ...newRun(), id: "held" });
        const running = yield* Effect.forkChild(daemon.run);
        yield* Deferred.await(entered);
        yield* store.putSchedule(schedule());
        yield* store.createRun({ ...newRun(), id: "new" });
        const duplicate = yield* Effect.forkChild(daemon.run);
        yield* Deferred.await(completed);
        expect((yield* store.getRun("held"))?.status).toBe("running");
        expect(
          yield* store.queryRuns({ status: "succeeded", limit: 200, now: newRun().createdAt }),
        ).toHaveLength(2);
        expect((yield* store.listSchedules())[0]?.nextFireAt).toBe(
          new Date(base + 60_000).toISOString(),
        );
        yield* Deferred.succeed(held, undefined);
        yield* daemon.stop;
        yield* Fiber.join(running);
        yield* Fiber.join(duplicate);
      }),
    ).pipe(Effect.provide(TestClock.layer())),
  );
});

test("preparation cleanup deadline unblocks stop and retains the original failure", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const releasing = yield* Deferred.make<void>();
        const errors: Cause.Cause<unknown>[] = [];

        class StalledStore extends MemorySqlStore {
          override release() {
            return Deferred.succeed(releasing, undefined).pipe(Effect.andThen(Effect.never));
          }
        }

        const store = new StalledStore();
        const preparation = new PreparationError({ cause: new Error("Missing revision") });

        const daemon = yield* makeDaemon({
          store,
          concurrency: 1,
          prepare: () => Effect.fail(preparation),
          definitionFor: () => Effect.succeed({ revision: "bundle", graph }),
          onError: (cause) => {
            errors.push(cause);
          },
        });

        yield* store.createRun(newRun());
        const running = yield* Effect.forkChild(daemon.run);
        yield* Deferred.await(releasing);
        const stop = yield* Effect.forkChild(daemon.stop);
        yield* TestClock.adjust(5000);
        yield* Fiber.join(stop);
        yield* Fiber.join(running);

        const reported = errors.flatMap((cause) =>
          cause.reasons.filter(Cause.isFailReason).map((reason) => reason.error),
        );

        const diagnostic = reported.find((error) => error instanceof LeaseReleaseUnknown);

        expect(diagnostic).toBeInstanceOf(LeaseReleaseUnknown);
        expect(diagnostic?.primary._tag).toBe("Success");
        expect(reported).toContain(preparation);
        expect(yield* store.getRun("run")).toMatchObject({ error: "Missing revision" });
      }),
    ).pipe(Effect.provide(TestClock.layer())),
  );
});

for (const failure of ["schedule", "scan"] as const) {
  test(`${failure} failure sleeps with capped backoff instead of spinning`, async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* TestClock.setTime(base);
          let scans = 0;
          let errors = 0;

          class CountingStore extends MemorySqlStore {
            override dueRuns(at: string) {
              scans++;

              return failure === "scan"
                ? Effect.fail(
                    new StorageError({
                      operation: "dueRuns",
                      reason: "unavailable",
                      cause: "fixture",
                    }),
                  )
                : super.dueRuns(at);
            }
          }

          const store = new CountingStore();

          if (failure === "schedule") {
            yield* store.putSchedule(schedule());
          }

          const daemon = yield* makeDaemon({
            store,
            concurrency: 1,
            prepare: () => Effect.succeed({ graph: empty, executor: new FakeExecutor() }),
            definitionFor: () => Effect.fail(new ScheduleDefinitionError({ cause: "fixture" })),
            onError: () => {
              errors++;
            },
          });

          const running = yield* Effect.forkChild(daemon.run);
          yield* TestClock.adjust(0);
          expect(scans).toBe(1);
          // A failed schedule waits for its persisted retry deadline, which matches the idle poll.
          const intervals = [5000, 5000, 5000];

          for (const [index, delay] of intervals.entries()) {
            yield* TestClock.adjust(delay - 1);
            expect(scans).toBe(index + 1);
            yield* TestClock.adjust(1);
            expect(scans).toBe(index + 2);
          }

          expect(errors).toBe(scans);
          yield* daemon.stop;
          yield* Fiber.join(running);
        }),
      ).pipe(Effect.provide(TestClock.layer())),
    );
  });
}

test("claim contention is silent while another queued run completes", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        class ContendedStore extends MemorySqlStore {
          override claim(id: string, token: string) {
            return id === "run" ? Effect.fail(new OwnershipError(id)) : super.claim(id, token);
          }
        }

        const store = new ContendedStore();
        const passes = countPasses(store);
        const errors: Cause.Cause<unknown>[] = [];

        const daemon = yield* makeDaemon({
          store,
          concurrency: 2,
          prepare: () => Effect.succeed({ graph: empty, executor: new FakeExecutor() }),
          definitionFor: () => Effect.succeed({ revision: "bundle", graph: empty }),
          onError: (cause) => {
            errors.push(cause);
          },
        });

        yield* store.createRun(newRun());
        yield* store.createRun({ ...newRun(), id: "second" });
        yield* Effect.forkScoped(daemon.run);
        yield* waitUntil(Effect.map(store.getRun("second"), (run) => run?.status === "succeeded"));
        yield* nextPass(daemon, passes);
        expect((yield* store.getRun("run"))?.status).toBe("queued");
        expect(errors).toEqual([]);
      }),
    ),
  );
});

test("stop waits for an in-flight scan and prevents another scan", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const gate = yield* Deferred.make<void>();
        let scans = 0;
        let stopped = false;

        class GatedStore extends MemorySqlStore {
          override dueRuns(at: string) {
            return Effect.gen({ self: this }, function* () {
              scans++;
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(gate);

              return yield* superDue(at);
            });
          }
        }

        // Capture the inherited operation before injecting the scan gate.
        const store = new GatedStore();
        const superDue = MemorySqlStore.prototype.dueRuns.bind(store);

        const daemon = yield* makeDaemon({
          store,
          concurrency: 1,
          prepare: () => Effect.succeed({ graph: empty, executor: new FakeExecutor() }),
          definitionFor: () => Effect.succeed({ revision: "bundle", graph: empty }),
        });

        const active = yield* Effect.forkChild(daemon.run);
        yield* Deferred.await(entered);

        const stop = yield* Effect.forkChild(
          daemon.stop.pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                stopped = true;
              }),
            ),
          ),
        );

        yield* Effect.yieldNow;
        expect(stopped).toBe(false);
        yield* Deferred.succeed(gate, undefined);
        yield* Fiber.join(stop);
        yield* Fiber.join(active);
        expect(stopped).toBe(true);
        expect(scans).toBe(1);
        yield* daemon.run;
        expect(scans).toBe(1);
      }),
    ),
  );
});

test("schedule mutation wakes the loop without repeated scans before its deadline", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(base);
        let scans = 0;

        class CountingStore extends MemorySqlStore {
          override dueRuns(at: string) {
            scans++;

            return super.dueRuns(at);
          }
        }

        const store = new CountingStore();

        const daemon = yield* makeDaemon({
          store,
          concurrency: 1,
          prepare: () => Effect.succeed({ graph: empty, executor: new FakeExecutor() }),
          definitionFor: () => Effect.succeed({ revision: "bundle", graph: empty }),
        });

        const running = yield* Effect.forkChild(daemon.run);
        yield* TestClock.adjust(0);
        expect(scans).toBe(1);
        yield* store.putSchedule({
          ...schedule(),
          nextFireAt: new Date(base + 1500).toISOString(),
        });
        yield* TestClock.adjust(0);
        expect(scans).toBe(2);
        yield* TestClock.adjust(1499);
        expect(scans).toBe(2);
        // Backoff minimum is 2s after this no-progress wake, even for an earlier persisted deadline.
        yield* TestClock.adjust(501);
        expect(scans).toBeGreaterThanOrEqual(3);
        expect(scans).toBeLessThanOrEqual(5);
        const afterProgress = scans;
        yield* TestClock.adjust(999);
        expect(scans).toBe(afterProgress);
        yield* daemon.stop;
        yield* Fiber.join(running);
      }),
    ).pipe(Effect.provide(TestClock.layer())),
  );
});

test("unrelated terminal run events leave idle sleep intact", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        let scans = 0;

        class CountingStore extends MemorySqlStore {
          override dueRuns(at: string) {
            scans++;

            return super.dueRuns(at);
          }
        }

        const store = new CountingStore();

        const daemon = yield* makeDaemon({
          store,
          concurrency: 1,
          prepare: () => Effect.succeed({ graph: empty, executor: new FakeExecutor() }),
          definitionFor: () => Effect.succeed({ revision: "bundle", graph: empty }),
        });

        const running = yield* Effect.forkChild(daemon.run);
        yield* TestClock.adjust(0);
        yield* store.createRun({ ...newRun(), status: "succeeded", output: null });
        yield* TestClock.adjust(4999);
        expect(scans).toBe(1);
        yield* TestClock.adjust(1);
        expect(scans).toBe(2);
        yield* daemon.stop;
        yield* Fiber.join(running);
      }),
    ).pipe(Effect.provide(TestClock.layer())),
  );
});

test("ownership loss reports activation unsubscribe defects instead of suppressing them as contention", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const defect = new Error("activation unsubscribe cleanup defect");
        const errors: Cause.Cause<unknown>[] = [];
        let subscriptions = 0;

        class LosingStore extends MemorySqlStore {
          override heartbeat() {
            return Effect.succeed(false);
          }
          override subscribe(listener: Parameters<MemorySqlStore["subscribe"]>[0]) {
            const unsubscribe = super.subscribe(listener);
            const index = ++subscriptions;

            return () => {
              unsubscribe();

              if (index > 1) {
                throw defect;
              }
            };
          }
        }

        const store = new LosingStore({ leaseMs: 1000 });

        const executor: Executor = {
          lookup: () => Effect.succeed({ kind: "none" }),
          execute: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
        };

        const daemon = yield* makeDaemon({
          store,
          concurrency: 1,
          prepare: () => Effect.succeed({ graph, executor }),
          definitionFor: () => Effect.succeed({ revision: "bundle", graph }),
          onError: (cause) => {
            errors.push(cause);
          },
        });

        yield* store.createRun(newRun());
        yield* Effect.forkScoped(daemon.run);
        yield* Deferred.await(entered);
        yield* TestClock.adjust(250);
        yield* waitUntil(Effect.sync(() => errors.length > 0));
        expect(errors).toHaveLength(1);

        const cleanup = errors
          .flatMap((cause) =>
            cause.reasons.filter(Cause.isFailReason).map((reason) => reason.error),
          )
          .find((error) => error instanceof DriverCleanupFailed);

        expect(cleanup).toBeInstanceOf(DriverCleanupFailed);

        if (!(cleanup instanceof DriverCleanupFailed)) {
          throw new Error("Missing driver cleanup diagnostic");
        }

        expect(
          cleanup.driver._tag === "Failure" &&
            cleanup.driver.cause.reasons.some(
              (reason) => Cause.isDieReason(reason) && reason.defect === defect,
            ),
        ).toBe(true);
        expect(
          cleanup.primary._tag === "Failure" &&
            cleanup.primary.cause.reasons.some(
              (reason) => Cause.isFailReason(reason) && reason.error instanceof OwnershipError,
            ),
        ).toBe(true);
        expect((yield* store.getRun("run"))?.owner).toBeUndefined();
      }),
    ).pipe(Effect.provide(TestClock.layer())),
  );
});

test("mixed preparation/interruption Cause never persists a business failure", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const preparation = new PreparationError({ cause: new Error("prepare interrupted") });
        const cause = Cause.combine(Cause.fail(preparation), Cause.interrupt(123));
        const store = new MemorySqlStore();
        const errors: Cause.Cause<unknown>[] = [];

        const daemon = yield* makeDaemon({
          store,
          concurrency: 1,
          prepare: () => Effect.failCause(cause),
          definitionFor: () => Effect.succeed({ revision: "bundle", graph }),
          onError: (cause) => {
            errors.push(cause);
          },
        });

        yield* store.createRun(newRun());
        yield* Effect.forkScoped(daemon.run);
        // TestClock holds the loop in its backoff after this single admission.
        yield* waitUntil(Effect.sync(() => errors.length > 0));
        expect(errors).toHaveLength(1);
        expect(errors.every((cause) => Cause.hasInterrupts(cause))).toBe(true);
        expect((yield* store.getRun("run"))?.status).toBe("queued");
        expect((yield* store.getRun("run"))?.owner).toBeUndefined();
      }),
    ).pipe(Effect.provide(TestClock.layer())),
  );
});
