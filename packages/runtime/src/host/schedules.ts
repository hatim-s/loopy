import { nextFire, parseCron, type RunRecord, type Schedule, type Store } from "@loopy/core";
import { Cause, Data, Effect } from "effect";

export class ScheduleRevisionError extends Data.TaggedError("ScheduleRevisionError")<{
  cause: unknown;
}> {}

type Options = {
  store: Store;
  revisionFor: (schedule: Schedule) => Effect.Effect<string, ScheduleRevisionError>;
  stopped: () => boolean;
  report: (cause: Cause.Cause<unknown>) => Effect.Effect<void>;
};

// A daemon that starts this late after a fire time advances the schedule instead of firing it.
const STARTUP_LATE_MS = 60_000;

export class ScheduleScheduler {
  private started = false;
  constructor(private readonly options: Options) {}

  tick(now: string) {
    return Effect.gen({ self: this }, function* () {
      const schedules = yield* this.options.store.listSchedules();
      const starting = !this.started;
      this.started = true;
      let fired = 0;

      for (const schedule of schedules) {
        if (this.options.stopped()) {
          break;
        }

        yield* Effect.gen({ self: this }, function* () {
          if (starting && Date.parse(now) - Date.parse(schedule.nextFireAt) > STARTUP_LATE_MS) {
            yield* this.options.store.advanceSchedule({
              workspace: schedule.workspace,
              slug: schedule.slug,
              version: schedule.version,
              nextFireAt: nextFire(
                parseCron(schedule.cron),
                new Date(now),
                schedule.tz,
              ).toISOString(),
            });

            return;
          }

          if (schedule.enabled && Date.parse(schedule.nextFireAt) <= Date.parse(now)) {
            fired += Number(yield* this.fire(schedule, now));
          }
        }).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterrupts(cause) ? Effect.failCause(cause) : this.options.report(cause),
          ),
        );
      }

      return fired;
    });
  }

  private fire(schedule: Schedule, now: string) {
    return Effect.gen({ self: this }, function* () {
      const at = new Date(schedule.nextFireAt);

      const run: RunRecord = {
        id: crypto.randomUUID(),
        slug: schedule.slug,
        revision: yield* this.options.revisionFor(schedule),
        workspace: schedule.workspace,
        input: schedule.input,
        status: "queued",
        createdAt: now,
        updatedAt: now,
      };

      return yield* this.options.store.fireSchedule({
        workspace: schedule.workspace,
        slug: schedule.slug,
        version: schedule.version,
        fireKey: `${schedule.slug}@${at.toISOString().slice(0, 16)}Z`,
        run,
        nextFireAt: nextFire(parseCron(schedule.cron), at, schedule.tz).toISOString(),
      });
    });
  }
}
