import type { PutScheduleBody, SavedLoopy } from "@loopy/contract";
import {
  DEFAULT_TIME_ZONE,
  errorMessage,
  nextFire,
  type Schedule,
  validateTimeZone,
} from "@loopy/core";
import { Effect } from "effect";
import type { ServiceContext } from "./context";
import { requireDefinition } from "./definition";
import { ServiceError } from "./error";
import { validateDefinitionInput } from "./input";

export function makeScheduleOperations(context: ServiceContext) {
  const scheduleTarget = Effect.fn("schedules.scheduleTarget")(function* (
    slug: string,
    callerWorkspace: string,
  ) {
    const registry = yield* context.registry(callerWorkspace);
    const saved = yield* requireDefinition(registry, slug);

    return { registry, saved, workspace: yield* registry.workspace() };
  });

  const scheduleOverview = Effect.fn("schedules.scheduleOverview")(function* () {
    return yield* context.store.scheduleOverview();
  });

  const listSchedules = Effect.fn("schedules.listSchedules")(function* (callerWorkspace: string) {
    const workspace = yield* (yield* context.registry(callerWorkspace)).workspace();

    return (yield* context.store.listSchedules())
      .filter((schedule) => schedule.workspace === workspace)
      .map((schedule) => scheduleView(schedule));
  });

  const scheduleView = (schedule: Schedule) => {
    return { ...schedule, lastFireKey: schedule.lastFireKey ?? null };
  };

  const putSchedule = Effect.fn("schedules.putSchedule")(function* (
    slug: string,
    body: PutScheduleBody,
    callerWorkspace: string,
  ) {
    const { saved, workspace } = yield* scheduleTarget(slug, callerWorkspace);
    const declared = saved.graph.meta.schedule;
    const cron = body.cron ?? declared?.cron;

    if (cron === undefined) {
      return yield* Effect.fail(
        new ServiceError(
          "invalid_schedule",
          `No schedule for '${slug}'. Pass --cron or add schedule to loopy().`,
        ),
      );
    }

    const tz = body.tz ?? declared?.tz ?? DEFAULT_TIME_ZONE;
    yield* validateTimezone(tz);
    const nextFireAt = yield* scheduleNextFire(cron, tz);
    const input = yield* scheduleInput(saved, body);

    return scheduleView(
      yield* context.store.putSchedule({
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
      validateTimeZone(tz);
    } catch (error) {
      return yield* Effect.fail(new ServiceError("invalid_timezone", errorMessage(error)));
    }
  });

  const scheduleNextFire = Effect.fn("schedules.scheduleNextFire")(function* (
    cron: string,
    tz: string,
  ) {
    try {
      return nextFire(cron, new Date(context.clock.now()), tz).toISOString();
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

    const schedule = (yield* context.store.listSchedules()).find(
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
    callerWorkspace: string,
  ) {
    const current = yield* requireSchedule(slug, callerWorkspace);

    const schedule = yield* context.store.setScheduleEnabled({
      workspace: current.workspace,
      slug,
      enabled,
      nextFireAt: enabled ? yield* scheduleNextFire(current.cron, current.tz) : undefined,
    });

    return scheduleView(schedule);
  });

  const deleteSchedule = Effect.fn("schedules.deleteSchedule")(function* (
    slug: string,
    callerWorkspace: string,
  ) {
    const { workspace } = yield* scheduleTarget(slug, callerWorkspace);
    yield* context.store.deleteSchedule(workspace, slug);

    return { deleted: true as const };
  });

  return { scheduleOverview, listSchedules, putSchedule, setScheduleEnabled, deleteSchedule };
}

export type ScheduleOperations = ReturnType<typeof makeScheduleOperations>;
