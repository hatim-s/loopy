import type {
  PutScheduleBody,
  SavedLoopy,
  ScheduleOverviewView,
  ScheduleView,
} from "../contract/index.js";
import { assertJson, errorMessage, nextFire, parseCron, type Schedule } from "../core/index.js";
import { requireDefinition } from "./definition.js";
import { ServiceError } from "./error.js";
import { validateDefinitionInput } from "./input.js";
import type { ServiceOptions } from "./registry.js";

export class ServiceSchedules {
  constructor(private readonly options: ServiceOptions) {}

  private async scheduleTarget(slug: string, callerWorkspace = "") {
    const registry = this.options.registry(callerWorkspace);
    const saved = await requireDefinition(registry, slug);

    return { registry, saved, workspace: await registry.workspace() };
  }

  async scheduleOverview(): Promise<ScheduleOverviewView> {
    return this.options.store.scheduleOverview();
  }

  async listSchedules(callerWorkspace = ""): Promise<ScheduleView[]> {
    const workspace = await this.options.registry(callerWorkspace).workspace();

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
    callerWorkspace = "",
  ): Promise<ScheduleView> {
    const { saved, workspace } = await this.scheduleTarget(slug, callerWorkspace);
    const cron = body.cron ?? saved.schedule?.cron;

    if (cron === undefined) {
      throw new ServiceError(
        "invalid_schedule",
        `No schedule for '${slug}'. Pass --cron or add schedule to loopy().`,
      );
    }

    const tz = body.tz ?? saved.schedule?.tz ?? "UTC";
    this.validateTimezone(tz);
    const nextFireAt = this.scheduleNextFire(cron, tz);
    const input = await this.scheduleInput(saved, body);

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
      new Intl.DateTimeFormat("en", { timeZone: tz });
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

  private async scheduleInput(saved: SavedLoopy, body: PutScheduleBody) {
    try {
      const input = validateDefinitionInput(saved, body.input === undefined ? {} : body.input);
      assertJson(input, "Schedule input");

      return input;
    } catch (error) {
      throw new ServiceError("bad_request", errorMessage(error));
    }
  }

  private async requireSchedule(slug: string, callerWorkspace: string): Promise<Schedule> {
    const { workspace } = await this.scheduleTarget(slug, callerWorkspace);

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
    callerWorkspace = "",
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

  async deleteSchedule(slug: string, callerWorkspace = ""): Promise<{ deleted: true }> {
    const { workspace } = await this.scheduleTarget(slug, callerWorkspace);
    await this.options.store.deleteSchedule(workspace, slug);

    return { deleted: true };
  }
}
