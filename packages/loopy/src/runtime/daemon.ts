import { type EngineRun, type ExecutionMode, errorMessage, type Schedule } from "../core/index.js";
import { type Clock, SYSTEM_CLOCK } from "./clock.js";
import { map } from "./concurrency.js";
import { fireKey, nextFire, parseCron } from "./cron.js";
import { type ActivationOptions, activate } from "./engine.js";
import type { Executor } from "./executor.js";
import type { RunStore } from "./store.js";

type DaemonOptions = {
  store: RunStore;
  executor: Executor;
  loadWorkflow: (run: EngineRun) => Promise<ActivationOptions["workflow"]>;
  clock?: Clock;
  concurrency?: number;
  cwdFor: (run: EngineRun) => string;
  modeFor: (run: EngineRun) => ExecutionMode;
  onError?: (error: Error, run?: EngineRun) => void;
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
  private readonly concurrency: number;
  private started = false;
  private stopped = false;
  private wakeRequested = false;
  private waiting?: AbortController;
  private ticking?: Promise<TickResult>;
  private running?: Promise<void>;

  constructor(private readonly options: DaemonOptions) {
    this.clock = options.clock ?? SYSTEM_CLOCK;
    this.concurrency = options.concurrency ?? 4;

    if (!Number.isSafeInteger(this.concurrency) || this.concurrency < 1) {
      throw new Error("Daemon concurrency must be a positive integer. Supply at least one worker.");
    }
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
    this.running ??= this.loop();

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
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.tick();
      } catch (error) {
        this.report(error);
      }

      await this.wait();
    }
  }

  private async performTick(): Promise<TickResult> {
    const now = new Date(this.clock.now()).toISOString();
    const fired = await this.fireSchedules(now);
    const runs = await this.options.store.dueRuns(now);

    const outcomes = await map(runs, (run) => this.activateRun(run), {
      concurrency: this.concurrency,
    });

    return { fired, activated: outcomes.filter(Boolean).length };
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

    const run: EngineRun = {
      id: crypto.randomUUID(),
      slug: schedule.slug,
      bundleHash: "",
      input: schedule.input,
      status: "queued",
      createdAt: now,
      updatedAt: now,
    };

    return this.options.store.fireSchedule(
      schedule.slug,
      fireKey(schedule.slug, at),
      run,
      nextFire(parseCron(schedule.cron), at, schedule.tz).toISOString(),
    );
  }

  private async activateRun(run: EngineRun): Promise<boolean> {
    if (this.stopped) {
      return false;
    }

    try {
      const workflow = await this.options.loadWorkflow(run);
      await activate({
        runId: run.id,
        store: this.options.store,
        executor: this.options.executor,
        workflow,
        cwd: this.options.cwdFor(run),
        mode: this.options.modeFor(run),
        clock: this.clock,
      });

      return true;
    } catch (error) {
      this.report(error, run);

      return false;
    }
  }

  private report(cause: unknown, run?: EngineRun): void {
    const error = cause instanceof Error ? cause : new Error(errorMessage(cause));
    this.options.onError?.(error, run);
  }

  private async wait(): Promise<void> {
    const controller = new AbortController();
    this.waiting = controller;

    try {
      if (this.stopped || this.wakeRequested) {
        return;
      }

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

      const milliseconds = Math.max(
        0,
        Math.min(5000, ...deadlines.map((at) => at - this.clock.now())),
      );

      await (this.options.sleep ?? sleep)(milliseconds, controller.signal);
    } finally {
      this.waiting = undefined;
      this.wakeRequested = false;
    }
  }
}
