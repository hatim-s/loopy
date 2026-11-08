import type { RunRecord, Schedule, Store } from "@loopy/core";
import { Cause, Clock, Deferred, Effect, Queue, Scope, Semaphore } from "effect";
import { activateRun, type Prepare } from "./daemon-activation";
import { ActivationPool } from "./pool";
import { type ScheduleRevisionError, ScheduleScheduler } from "./schedules";
import { subscribeStore } from "./subscription";

export type DaemonOptions = {
  store: Store;
  prepare: Prepare;
  concurrency: number;
  revisionFor: (schedule: Schedule) => Effect.Effect<string, ScheduleRevisionError>;
  onError?: (cause: Cause.Cause<unknown>, run?: RunRecord) => void;
};

const PRUNE_INTERVAL_MS = 3_600_000;

const IDLE_POLL_MS = 5000;

const MIN_BACKOFF_MS = 1000;

const MAX_BACKOFF_MS = 5000;

export const makeDaemon = (options: DaemonOptions) =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const inbox = yield* Queue.sliding<void>(1);
    const lock = yield* Semaphore.make(1);
    const { store } = options;

    const wake = Effect.sync(() => {
      Queue.offerUnsafe(inbox, undefined);
    });

    let stopped = false;
    let nextPruneAt = 0;
    let progress = 0;

    const report = (cause: Cause.Cause<unknown>, run?: RunRecord) =>
      Effect.sync(() => options.onError?.(cause, run));

    const pool = new ActivationPool(options.concurrency, (run) =>
      activateRun({ store, prepare: options.prepare, stopped: () => stopped, report }, run).pipe(
        Effect.tap((advanced) =>
          advanced
            ? Effect.sync(() => {
                progress++;
                Queue.offerUnsafe(inbox, undefined);
              })
            : Effect.void,
        ),
      ),
    );

    const schedules = new ScheduleScheduler({
      store,
      revisionFor: options.revisionFor,
      stopped: () => stopped,
      report,
    });

    yield* subscribeStore(store, (events) => {
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
    });

    const admitDue = Effect.gen(function* () {
      if (stopped) {
        return 0;
      }

      const time = yield* Clock.currentTimeMillis;
      const now = new Date(time).toISOString();

      if (time >= nextPruneAt) {
        yield* store.pruneEvents(now);
        nextPruneAt = time + PRUNE_INTERVAL_MS;
      }

      const fired = yield* schedules.tick(now);

      for (const run of yield* store.dueRuns(now)) {
        yield* pool.start(run);
      }

      return fired;
    });

    const wait = (milliseconds: number) =>
      Effect.raceFirst(Queue.take(inbox), Effect.sleep(milliseconds));

    const waitDuration = (minimum: number) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;

        const deadlines = [yield* store.nextWakeAt(), yield* store.nextScheduleAt()].flatMap(
          (at) => (at === undefined ? [] : [Date.parse(at) - now]),
        );

        // Active work wakes the loop itself, so the idle poll only covers deadlines and failures.
        const ceiling = pool.active > 0 && minimum > 0 ? minimum : IDLE_POLL_MS;

        return Math.max(minimum, Math.min(ceiling, ...deadlines));
      });

    const loop = Effect.gen(function* () {
      let backoff = MIN_BACKOFF_MS;

      while (!stopped) {
        yield* Effect.gen(function* () {
          const fired = yield* lock
            .withPermit(admitDue)
            .pipe(Effect.provideService(Scope.Scope, scope));

          const advanced = fired + progress;
          progress = 0;

          if (!stopped) {
            yield* wait(yield* waitDuration(advanced > 0 ? 0 : backoff));
          }

          backoff = advanced > 0 ? MIN_BACKOFF_MS : Math.min(MAX_BACKOFF_MS, backoff * 2);
        }).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterrupts(cause)
              ? Effect.failCause(cause)
              : report(cause).pipe(Effect.andThen(stopped ? Effect.void : wait(MAX_BACKOFF_MS))),
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
      yield* lock.withPermit(Effect.void);
      yield* pool.drain();

      if (running) {
        yield* Deferred.await(running);
      }
    });

    // Workers and the loop finish before the subscription and storage close with this scope.
    yield* Effect.addFinalizer(() => Effect.orDie(stop));

    return { run, wake, stop };
  });
