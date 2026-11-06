import type { RunRecord, Schedule, Store } from "@loopy/core";
import { Cause, Clock, Deferred, Effect, Fiber, Queue, Scope, Semaphore } from "effect";
import type { ActivationOptions } from "./activation";
import { activateRun, type PreparationError } from "./daemon-activation";
import { ActivationPool } from "./pool";
import { type ScheduleRevisionError, ScheduleScheduler } from "./schedules";

export type DaemonOptions = {
  store: Store;
  prepare: (
    run: RunRecord,
  ) => Effect.Effect<Pick<ActivationOptions, "graph" | "executor">, PreparationError>;
  concurrency: number;
  revisionFor: (schedule: Schedule) => Effect.Effect<string, ScheduleRevisionError>;
  onError?: (cause: Cause.Cause<unknown>, run?: RunRecord) => void;
};

/** The root scope owns subscriptions and admitted workers. stop drains before composition closes it. */
export const makeDaemon = (options: DaemonOptions) =>
  Effect.gen(function* () {
    if (!Number.isSafeInteger(options.concurrency) || options.concurrency < 1) {
      return yield* Effect.die(new Error("Daemon concurrency must be a positive integer."));
    }

    const scope = yield* Effect.scope;
    const inbox = yield* Queue.sliding<void>(1);
    const lock = yield* Semaphore.make(1);

    const wake = Effect.sync(() => {
      Queue.offerUnsafe(inbox, undefined);
    });

    let stopped = false;
    let nextPruneAt = 0;
    let ticks = 0;
    let ticksDone = Deferred.makeUnsafe<void>();
    yield* Deferred.succeed(ticksDone, undefined);

    const report = (cause: Cause.Cause<unknown>, run?: RunRecord) =>
      Effect.sync(() => options.onError?.(cause, run));

    const pool = new ActivationPool(
      options.concurrency,
      (run) =>
        activateRun(
          {
            store: options.store,
            prepare: options.prepare,
            stopped: () => stopped,
            onError: (cause, run) => options.onError?.(cause, run),
          },
          run,
        ),
      () => {
        Queue.offerUnsafe(inbox, undefined);
      },
    );

    const schedules = new ScheduleScheduler({
      store: options.store,
      revisionFor: options.revisionFor,
      stopped: () => stopped,
      onError: (cause) => options.onError?.(cause),
    });

    yield* Effect.acquireRelease(
      Effect.sync(() =>
        options.store.subscribe((events) => {
          if (
            events.some((event) =>
              event.entity === "run"
                ? event.kind === "woken" ||
                  (event.kind === "created" && event.record.status === "queued")
                : event.entity === "schedule" && event.kind === "saved",
            )
          ) {
            Queue.offerUnsafe(inbox, undefined);
          }
        }),
      ),
      (unsubscribe) => Effect.sync(unsubscribe),
    );

    const dueWork = Effect.gen(function* () {
      const time = yield* Clock.currentTimeMillis;
      const now = new Date(time).toISOString();

      if (time >= nextPruneAt) {
        yield* options.store.pruneEvents(now);
        nextPruneAt = time + 3_600_000;
      }

      return { fired: yield* schedules.tick(now), runs: yield* options.store.dueRuns(now) };
    });

    const admit = (run: RunRecord) =>
      lock
        .withPermit(
          Effect.gen(function* () {
            if (stopped || pool.has(run.id)) {
              return { kind: "skip" } as const;
            }

            if (pool.active >= options.concurrency) {
              return { kind: "full", fibers: pool.fibers() } as const;
            }

            return { kind: "started", fiber: yield* pool.start(run) } as const;
          }),
        )
        .pipe(Effect.provideService(Scope.Scope, scope));

    const tickBody = Effect.gen(function* () {
      const due = yield* lock.withPermit(
        Effect.suspend(() => (stopped ? Effect.succeed({ fired: 0, runs: [] }) : dueWork)),
      );

      const admitted: Fiber.Fiber<boolean, Effect.Error<ReturnType<typeof activateRun>>>[] = [];

      for (const run of due.runs) {
        while (!stopped) {
          const result = yield* admit(run);

          if (result.kind === "full") {
            // Waiting outside the permit leaves scans and schedule mutations live.
            yield* Effect.forEach(result.fibers, Fiber.join, {
              concurrency: "unbounded",
              discard: true,
            });
            continue;
          }

          if (result.kind === "started" && result.fiber) {
            admitted.push(result.fiber);
          }

          break;
        }
      }

      const progress = yield* Effect.forEach(admitted, Fiber.join, { concurrency: "unbounded" });

      return { fired: due.fired, activated: progress.filter(Boolean).length };
    });

    const tick = Effect.acquireUseRelease(
      Effect.sync(() => {
        if (ticks++ === 0) {
          ticksDone = Deferred.makeUnsafe<void>();
        }
      }),
      () => tickBody,
      () =>
        Effect.gen(function* () {
          if (--ticks === 0) {
            yield* Deferred.succeed(ticksDone, undefined);
          }
        }),
    );

    const wait = (milliseconds: number) =>
      Effect.raceFirst(Queue.take(inbox), Effect.sleep(milliseconds));

    const waitDuration = (minimum: number) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const wakeAt = yield* options.store.nextWakeAt();

        const deadlines = (yield* options.store.listSchedules())
          .filter((schedule) => schedule.enabled)
          .map((schedule) => Date.parse(schedule.nextFireAt));

        if (wakeAt) {
          deadlines.push(Date.parse(wakeAt));
        }

        return Math.max(
          minimum,
          Math.min(
            pool.active > 0 && minimum > 0 ? minimum : 5000,
            ...deadlines.map((at) => at - now),
          ),
        );
      });

    const loop = Effect.gen(function* () {
      let backoff = 1000;

      while (!stopped) {
        yield* Effect.gen(function* () {
          const fired = yield* lock
            .withPermit(
              Effect.gen(function* () {
                if (stopped) {
                  return 0;
                }

                const due = yield* dueWork;

                for (const run of due.runs) {
                  yield* pool.start(run);
                }

                return due.fired;
              }),
            )
            .pipe(Effect.provideService(Scope.Scope, scope));

          const progress = fired + pool.takeProgress();

          if (!stopped) {
            yield* wait(yield* waitDuration(progress > 0 ? 0 : backoff));
          }

          backoff = progress > 0 ? 1000 : Math.min(5000, backoff * 2);
        }).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterrupts(cause)
              ? Effect.failCause(cause)
              : report(cause).pipe(Effect.andThen(stopped ? Effect.void : wait(5000))),
          ),
        );
      }
    });

    let running: Deferred.Deferred<void> | undefined;

    const run = Effect.suspend(() => {
      if (running) {
        return Deferred.await(running);
      }

      if (stopped) {
        return Effect.void;
      }

      const done = Deferred.makeUnsafe<void>();
      running = done;

      return loop.pipe(Effect.ensuring(Deferred.succeed(done, undefined)));
    });

    const stop = Effect.gen(function* () {
      stopped = true;
      yield* wake;
      // A scan already in flight must finish before subscriptions/storage can close.
      yield* lock.withPermit(Effect.void);
      yield* pool.drain();
      yield* Deferred.await(ticksDone);

      if (running) {
        yield* Deferred.await(running);
      }
    });

    return { tick, run, wake, stop };
  });
