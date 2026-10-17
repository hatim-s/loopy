import { errorMessage, type RunRecord, type Schedule } from "../core/index.js";
import { type Clock, SYSTEM_CLOCK } from "./clock.js";
import { nextFire, parseCron } from "./cron.js";
import { type ActivationOptions, activate } from "./engine.js";
import { ActivationPool } from "./pool.js";
import { OwnershipError, type RunStore } from "./store.js";

type DaemonOptions = {
  store: RunStore;
  prepare: (
    run: RunRecord,
  ) => Promise<
    Pick<
      ActivationOptions,
      "workflow" | "wrap" | "executor" | "mode" | "cwd" | "signal" | "rateLimits"
    >
  >;
  clock?: Clock;
  concurrency?: number;
  bundleHashFor: (schedule: Schedule) => string | Promise<string>;
  onError?: (error: Error, run?: RunRecord) => void;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
};

type TickResult = { fired: number; activated: number };

function sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();

      return;
    }

    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };

    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });
  });
}

export class Daemon {
  private readonly clock: Clock;
  private readonly pool: ActivationPool;
  private started = false;
  private nextPruneAt = 0;
  private stopped = false;
  private wakeRequested = false;
  private waiting?: AbortController;
  private ticking?: Promise<TickResult>;
  private running?: Promise<void>;

  constructor(private readonly options: DaemonOptions) {
    this.clock = options.clock ?? SYSTEM_CLOCK;
    const concurrency = options.concurrency ?? 4;

    if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
      throw new Error("Daemon concurrency must be a positive integer. Supply at least one worker.");
    }

    this.pool = new ActivationPool(
      concurrency,
      (run) => this.activateRun(run),
      () => this.wake(),
    );
  }

  tick(): Promise<TickResult> {
    if (this.stopped) {
      return Promise.resolve({ fired: 0, activated: 0 });
    }

    this.ticking ??= this.performTick().finally(() => {
      this.ticking = undefined;
    });

    return this.ticking;
  }

  run(): Promise<void> {
    this.running ??= this.loop().finally(() => {
      this.running = undefined;
    });

    return this.running;
  }

  wake(): void {
    this.wakeRequested = true;
    this.waiting?.abort();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.wake();
    await this.ticking;
    await this.running;
    await this.pool.drain();
  }

  private async loop(): Promise<void> {
    let delay = 1000;

    while (!this.stopped) {
      try {
        const { fired, runs } = await this.dueWork();

        for (const run of runs) {
          this.pool.start(run);
        }

        const progress = fired + this.pool.takeProgress();
        await this.wait({ minimum: progress > 0 ? 0 : delay });
        delay = progress > 0 ? 1000 : Math.min(5000, delay * 2);
      } catch (error) {
        this.report(error);
        await this.wait({ milliseconds: 5000 });
      }
    }

    await this.pool.drain();
  }

  private async dueWork() {
    const time = this.clock.now();
    const now = new Date(time).toISOString();

    if (time >= this.nextPruneAt) {
      await this.options.store.pruneEvents(now);
      this.nextPruneAt = time + 3_600_000;
    }

    const fired = await this.fireSchedules(now);
    const runs = await this.options.store.dueRuns(now);

    return { fired, runs };
  }

  private async performTick(): Promise<TickResult> {
    const { fired, runs } = await this.dueWork();
    const activated = await this.pool.activateAll(runs);

    return { fired, activated };
  }

  private async fireSchedules(now: string): Promise<number> {
    const schedules = await this.options.store.listSchedules();
    const starting = !this.started;
    this.started = true;
    let fired = 0;

    for (const schedule of schedules) {
      if (this.stopped) {
        break;
      }

      try {
        if (starting && Date.parse(now) - Date.parse(schedule.nextFireAt) > 60_000) {
          await this.options.store.putSchedule({
            ...schedule,
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
        this.report(error);
      }
    }

    return fired;
  }

  private async fire(schedule: Schedule, now: string): Promise<boolean> {
    const at = new Date(schedule.nextFireAt);

    const run: RunRecord = {
      id: crypto.randomUUID(),
      slug: schedule.slug,
      bundleHash: await this.options.bundleHashFor(schedule),
      workspace: schedule.workspace,
      input: schedule.input,
      status: "queued",
      createdAt: now,
      updatedAt: now,
    };

    return this.options.store.fireSchedule(
      schedule.workspace,
      schedule.slug,
      `${schedule.slug}@${at.toISOString().slice(0, 16)}Z`,
      run,
      nextFire(parseCron(schedule.cron), at, schedule.tz).toISOString(),
    );
  }

  private async activateRun(run: RunRecord): Promise<boolean> {
    if (this.stopped) {
      return false;
    }

    try {
      const prepared = await this.prepareRun(run);

      if (!prepared) {
        return true;
      }

      const outcome = await activate({
        runId: run.id,
        store: this.options.store,
        clock: this.clock,
        ...prepared,
      });

      return (
        outcome.status !== "suspended" ||
        outcome.wakeAt === undefined ||
        Date.parse(outcome.wakeAt) > this.clock.now()
      );
    } catch (error) {
      if (!(error instanceof OwnershipError)) {
        this.report(error, run);
      }

      return false;
    }
  }

  private async prepareRun(run: RunRecord) {
    try {
      return await this.options.prepare(run);
    } catch (error) {
      const { store } = this.options;
      const token = crypto.randomUUID();
      await store.claim(run.id, token);

      try {
        await store.finishRun(run.id, token, { status: "failed", error: errorMessage(error) });
      } finally {
        await store.release(run.id, token);
      }

      this.report(error, run);

      return undefined;
    }
  }

  private report(cause: unknown, run?: RunRecord): void {
    const error = cause instanceof Error ? cause : new Error(errorMessage(cause));
    this.options.onError?.(error, run);
  }

  private async wait(delay: { milliseconds: number } | { minimum: number }): Promise<void> {
    const controller = new AbortController();
    this.waiting = controller;

    try {
      if (this.stopped || this.wakeRequested) {
        return;
      }

      const milliseconds =
        "milliseconds" in delay ? delay.milliseconds : await this.waitDuration(delay.minimum);

      await (this.options.sleep ?? sleep)(milliseconds, controller.signal);
    } finally {
      this.waiting = undefined;
      this.wakeRequested = false;
    }
  }

  private async waitDuration(minimum: number): Promise<number> {
    const [wakeAt, schedules] = await Promise.all([
      this.options.store.nextWakeAt(),
      this.options.store.listSchedules(),
    ]);

    const deadlines = schedules
      .filter((schedule) => schedule.enabled)
      .map((schedule) => Date.parse(schedule.nextFireAt));

    if (wakeAt !== undefined) {
      deadlines.push(Date.parse(wakeAt));
    }

    return Math.max(
      minimum,
      Math.min(
        this.pool.active > 0 && minimum > 0 ? minimum : 5000,
        ...deadlines.map((at) => at - this.clock.now()),
      ),
    );
  }
}
