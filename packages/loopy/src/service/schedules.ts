import { Effect } from "effect";
import type { PutScheduleBody, SavedLoopy } from "../contract";
import { errorMessage, nextFire, parseCron, type Schedule } from "../core";
import { requireDefinition } from "./definition";
import { ServiceError } from "./error";
import { validateDefinitionInput } from "./input";
import type { ServiceOptions } from "./registry";

export function makeScheduleOperations(options: ServiceOptions) {
  const scheduleTarget = Effect.fn("schedules.scheduleTarget")(function* (
    slug: string,
    callerWorkspace = "",
  ) {
    const registry = yield* options.registry(callerWorkspace);
    const saved = yield* requireDefinition(registry, slug);

    return { registry, saved, workspace: yield* registry.workspace() };
  });

  const scheduleOverview = Effect.fn("schedules.scheduleOverview")(function* () {
    return yield* options.store.scheduleOverview();
  });

  const listSchedules = Effect.fn("schedules.listSchedules")(function* (callerWorkspace = "") {
    const workspace = yield* (yield* options.registry(callerWorkspace)).workspace();

    return (yield* options.store.listSchedules())
      .filter((schedule) => schedule.workspace === workspace)
      .map((schedule) => scheduleView(schedule));
  });

  const scheduleView = (schedule: Schedule) => {
    return { ...schedule, lastFireKey: schedule.lastFireKey ?? null };
  };

  const putSchedule = Effect.fn("schedules.putSchedule")(function* (
    slug: string,
    body: PutScheduleBody,
    callerWorkspace = "",
  ) {
    const { saved, workspace } = yield* scheduleTarget(slug, callerWorkspace);
    const cron = body.cron ?? saved.schedule?.cron;

    if (cron === undefined) {
      return yield* Effect.fail(
        new ServiceError(
          "invalid_schedule",
          `No schedule for '${slug}'. Pass --cron or add schedule to loopy().`,
        ),
      );
    }

    const tz = body.tz ?? saved.schedule?.tz ?? "UTC";
    yield* validateTimezone(tz);
    const nextFireAt = yield* scheduleNextFire(cron, tz);
    const input = yield* scheduleInput(saved, body);

    return scheduleView(
      yield* options.store.putSchedule({
        workspace,
        slug,
        cron,
        tz,
        input,
        enabled: body.enabled ?? true,
        nextFireAt,
      }),
    );
  });

  const validateTimezone = Effect.fn("schedules.validateTimezone")(function* (tz: string) {
    try {
      new Intl.DateTimeFormat("en", { timeZone: tz });
    } catch (error) {
      return yield* Effect.fail(new ServiceError("invalid_timezone", errorMessage(error)));
    }
  });

  const scheduleNextFire = Effect.fn("schedules.scheduleNextFire")(function* (
    cron: string,
    tz: string,
  ) {
    try {
      return nextFire(parseCron(cron), new Date(options.clock.now()), tz).toISOString();
    } catch (error) {
      return yield* Effect.fail(new ServiceError("invalid_cron", errorMessage(error)));
    }
  });

  const scheduleInput = (saved: SavedLoopy, body: PutScheduleBody) =>
    validateDefinitionInput(saved, body.input === undefined ? {} : body.input);

  const requireSchedule = Effect.fn("schedules.requireSchedule")(function* (
    slug: string,
    callerWorkspace: string,
  ) {
    const { workspace } = yield* scheduleTarget(slug, callerWorkspace);

    const schedule = (yield* options.store.listSchedules()).find(
      (entry) => entry.workspace === workspace && entry.slug === slug,
    );

    if (!schedule) {
      return yield* Effect.fail(new ServiceError("not_found"));
    }

    return schedule;
  });

  const setScheduleEnabled = Effect.fn("schedules.setScheduleEnabled")(function* (
    slug: string,
    enabled: boolean,
    callerWorkspace = "",
  ) {
    const current = yield* requireSchedule(slug, callerWorkspace);

    const schedule = yield* options.store.setScheduleEnabled({
      workspace: current.workspace,
      slug,
      enabled,
      nextFireAt: enabled ? yield* scheduleNextFire(current.cron, current.tz) : undefined,
    });

    return scheduleView(schedule);
  });

  const deleteSchedule = Effect.fn("schedules.deleteSchedule")(function* (
    slug: string,
    callerWorkspace = "",
  ) {
    const { workspace } = yield* scheduleTarget(slug, callerWorkspace);
    yield* options.store.deleteSchedule(workspace, slug);

    return { deleted: true as const };
  });

  return { scheduleOverview, listSchedules, putSchedule, setScheduleEnabled, deleteSchedule };
}

export type ScheduleOperations = ReturnType<typeof makeScheduleOperations>;
