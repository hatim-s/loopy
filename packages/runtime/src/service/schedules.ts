import { type PutScheduleBody, type SavedLoopy, scheduleView } from "@loopy/contract";
import { DEFAULT_TIME_ZONE, errorMessage, nextFire, validateTimeZone } from "@loopy/core";
import { Clock, Effect } from "effect";
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
    const schedules = yield* context.store.listSchedules();

    const failures = new Map(
      (yield* context.store.scheduleFailures(schedules.length))
        .filter((failure) => failure.workspace === workspace)
        .map(({ slug, error, retryAt }) => [slug, { error, retryAt }]),
    );

    return schedules
      .filter((schedule) => schedule.workspace === workspace)
      .map((schedule) => scheduleView(schedule, failures.get(schedule.slug) ?? null));
  });

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
      null,
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
    const from = new Date(yield* Clock.currentTimeMillis);

    try {
      return nextFire(cron, from, tz).toISOString();
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

    // Saving or toggling bumps the version, which retires any failure of the previous version.
    const schedule = yield* context.store.setScheduleEnabled({
      workspace: current.workspace,
      slug,
      enabled,
      nextFireAt: enabled ? yield* scheduleNextFire(current.cron, current.tz) : undefined,
    });

    return scheduleView(schedule, null);
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
