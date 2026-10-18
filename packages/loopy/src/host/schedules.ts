import {
  errorMessage,
  nextFire,
  parseCron,
  type RunRecord,
  type Schedule,
  type Store,
} from "../core/index.js";

type Options = {
  store: Store;
  revisionFor: (schedule: Schedule) => string | Promise<string>;
  stopped: () => boolean;
  onError: (error: Error) => void;
};

export class ScheduleScheduler {
  private started = false;
  constructor(private readonly options: Options) {}

  async tick(now: string): Promise<number> {
    const schedules = await this.options.store.listSchedules();
    const starting = !this.started;
    this.started = true;
    let fired = 0;

    for (const schedule of schedules) {
      if (this.options.stopped()) {
        break;
      }

      try {
        if (starting && Date.parse(now) - Date.parse(schedule.nextFireAt) > 60_000) {
          await this.options.store.advanceSchedule({
            workspace: schedule.workspace,
            slug: schedule.slug,
            version: schedule.version,
            nextFireAt: nextFire(
              parseCron(schedule.cron),
              new Date(now),
              schedule.tz,
            ).toISOString(),
          });
          continue;
        }

        if (schedule.enabled && Date.parse(schedule.nextFireAt) <= Date.parse(now)) {
          fired += Number(await this.fire(schedule, now));
        }
      } catch (error) {
        this.options.onError(error instanceof Error ? error : new Error(errorMessage(error)));
      }
    }

    return fired;
  }

  private async fire(schedule: Schedule, now: string): Promise<boolean> {
    const at = new Date(schedule.nextFireAt);

    const run: RunRecord = {
      id: crypto.randomUUID(),
      slug: schedule.slug,
      revision: await this.options.revisionFor(schedule),
      workspace: schedule.workspace,
      input: schedule.input,
      status: "queued",
      createdAt: now,
      updatedAt: now,
    };

    return this.options.store.fireSchedule({
      workspace: schedule.workspace,
      slug: schedule.slug,
      version: schedule.version,
      fireKey: `${schedule.slug}@${at.toISOString().slice(0, 16)}Z`,
      run,
      nextFireAt: nextFire(parseCron(schedule.cron), at, schedule.tz).toISOString(),
    });
  }
}
