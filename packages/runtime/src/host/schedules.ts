import {
  errorMessage,
  type Graph,
  nextFire,
  type Schedule,
  type Store,
  validateGraphInput,
} from "@loopy/core";
import { Cause, Data, Effect } from "effect";

export class ScheduleDefinitionError extends Data.TaggedError("ScheduleDefinitionError")<{
  cause: unknown;
}> {
  override get message() {
    return errorMessage(this.cause);
  }
}

export type ScheduleDefinition = { revision: string; graph: Graph };

// A slot more than graceMs late is skipped rather than fired, on every host.
export const SCHEDULE_POLICY = {
  batch: 32,
  retryMs: 5000,
  errorChars: 1000,
  graceMs: 60_000,
} as const;

export type ScheduleFiringOptions = {
  store: Pick<Store, "dueSchedules" | "fireSchedule" | "skipSchedule" | "failSchedule">;
  definitionFor: (schedule: Schedule) => Effect.Effect<ScheduleDefinition, ScheduleDefinitionError>;
  stopped?: () => boolean;
  report?: (cause: Cause.Cause<unknown>) => Effect.Effect<void>;
};

const fireOne = (options: ScheduleFiringOptions, schedule: Schedule, now: string) =>
  Effect.gen(function* () {
    const next = nextFire(schedule.cron, new Date(now), schedule.tz).toISOString();

    if (Date.parse(now) - Date.parse(schedule.nextFireAt) > SCHEDULE_POLICY.graceMs) {
      yield* options.store.skipSchedule({ schedule, next });

      return false;
    }

    const { revision, graph } = yield* options.definitionFor(schedule);
    const input = validateGraphInput(graph, schedule.input);

    if (!input.ok) {
      yield* options.store.failSchedule({
        schedule,
        error: `Schedule disabled because the saved input no longer matches the current graph: ${input.error}`,
        retryAt: null,
      });

      return false;
    }

    return yield* options.store.fireSchedule({
      schedule,
      next,
      run: {
        id: crypto.randomUUID(),
        slug: schedule.slug,
        revision,
        workspace: schedule.workspace,
        input: input.value,
        status: "queued",
        createdAt: now,
        updatedAt: now,
      },
    });
  });

/**
 * A due slot fires once as now, and the next slot follows the current time. A failed schedule
 * waits for a persisted retry deadline so later schedules still enter the batch.
 */
export const fireDueSchedules = (options: ScheduleFiringOptions, now: string) =>
  Effect.gen(function* () {
    let fired = 0;

    for (const schedule of yield* options.store.dueSchedules(now, SCHEDULE_POLICY.batch)) {
      if (options.stopped?.()) {
        break;
      }

      fired += Number(
        yield* fireOne(options, schedule, now).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterrupts(cause)
              ? Effect.failCause(cause)
              : options.store
                  .failSchedule({
                    schedule,
                    error: errorMessage(Cause.squash(cause)).slice(0, SCHEDULE_POLICY.errorChars),
                    retryAt: new Date(Date.parse(now) + SCHEDULE_POLICY.retryMs).toISOString(),
                  })
                  .pipe(Effect.andThen(options.report?.(cause) ?? Effect.void), Effect.as(false)),
          ),
        ),
      );
    }

    return fired;
  });
