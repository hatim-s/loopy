import { type PutScheduleBody, type ScheduleView } from "../../contract/index.js";
import {
  assertTimeZone,
  errorMessage,
  nextFire,
  parseCron,
  type Schedule,
} from "../../core/index.js";
import { ServiceError } from "../service-error.js";
import { ServiceContext } from "./context.js";

export class SchedulesService extends ServiceContext {
  async listSchedules(callerWorkspace: string): Promise<ScheduleView[]> {
    const workspace = this.options.registry(callerWorkspace).project;

    return (await this.options.store.listSchedules())
      .filter((schedule) => schedule.workspace === workspace)
      .map((schedule) => this.scheduleView(schedule));
  }

  private scheduleView(schedule: Schedule): ScheduleView {
    return { ...schedule, lastFireKey: schedule.lastFireKey ?? null };
  }

  async putSchedule(
    slug: string,
    body: PutScheduleBody,
    callerWorkspace: string,
  ): Promise<ScheduleView> {
    const { saved, workspace } = this.target(slug, callerWorkspace);
    const cron = body.cron ?? saved.graph.meta.schedule?.cron;

    if (cron === undefined) {
      throw new ServiceError(
        "invalid_schedule",
        `No schedule for '${slug}'. Pass --cron or add schedule to loopy().`,
      );
    }

    const tz = body.tz ?? saved.graph.meta.schedule?.tz ?? "UTC";
    this.validateTimezone(tz);
    const nextFireAt = this.scheduleNextFire(cron, tz);
    const input = this.validateInput(saved, body.input ?? {});

    return this.scheduleView(
      await this.options.store.putSchedule({
        workspace,
        slug,
        cron,
        tz,
        input,
        enabled: body.enabled ?? true,
        nextFireAt,
      }),
    );
  }

  private validateTimezone(tz: string): void {
    try {
      assertTimeZone(tz);
    } catch (error) {
      throw new ServiceError("invalid_timezone", errorMessage(error));
    }
  }

  private scheduleNextFire(cron: string, tz: string) {
    try {
      return nextFire(parseCron(cron), new Date(this.options.clock.now()), tz).toISOString();
    } catch (error) {
      throw new ServiceError("invalid_cron", errorMessage(error));
    }
  }

  private async requireSchedule(slug: string, callerWorkspace: string): Promise<Schedule> {
    const { workspace } = this.target(slug, callerWorkspace);

    const schedule = (await this.options.store.listSchedules()).find(
      (entry) => entry.workspace === workspace && entry.slug === slug,
    );

    if (!schedule) {
      throw new ServiceError("not_found");
    }

    return schedule;
  }

  async setScheduleEnabled(
    slug: string,
    enabled: boolean,
    callerWorkspace: string,
  ): Promise<ScheduleView> {
    const current = await this.requireSchedule(slug, callerWorkspace);

    const schedule = await this.options.store.setScheduleEnabled({
      workspace: current.workspace,
      slug,
      enabled,
      nextFireAt: enabled
        ? nextFire(
            parseCron(current.cron),
            new Date(this.options.clock.now()),
            current.tz,
          ).toISOString()
        : undefined,
    });

    return this.scheduleView(schedule);
  }

  async deleteSchedule(slug: string, callerWorkspace: string): Promise<{ deleted: true }> {
    const { workspace } = this.target(slug, callerWorkspace);
    await this.options.store.deleteSchedule(workspace, slug);

    return { deleted: true };
  }
}
