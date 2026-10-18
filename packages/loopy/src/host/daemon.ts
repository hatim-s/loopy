import {
  errorMessage,
  type RunRecord,
  type Schedule,
  type Store,
  StoreError,
  toError,
} from "../core/index.js";
import { type ActivationOptions, activate } from "./activate.js";
import { type Clock, SYSTEM_CLOCK } from "./clock.js";
import { ActivationPool } from "./pool.js";
import { ScheduleScheduler } from "./schedules.js";

const PRUNE_INTERVAL_MS = 3_600_000;

const IDLE_CAP_MS = 5000;

type DaemonOptions = {
  store: Store;
  prepare: (run: RunRecord) => Promise<Pick<ActivationOptions, "graph" | "executor" | "signal">>;
  clock?: Clock;
  concurrency: number;
  revisionFor: (schedule: Schedule) => string | Promise<string>;
  onError?: (error: Error, run?: RunRecord) => void;
};

export class Daemon {
  private readonly clock: Clock;
  private readonly pool: ActivationPool;
  private readonly schedules: ScheduleScheduler;
  private nextPruneAt = 0;
  private status: "idle" | "waiting" | "stopping" = "idle";
  private wakeController = new AbortController();
  private running?: Promise<void>;

  constructor(private readonly options: DaemonOptions) {
    this.clock = options.clock ?? SYSTEM_CLOCK;
    this.schedules = new ScheduleScheduler({
      store: options.store,
      revisionFor: options.revisionFor,
      stopped: () => this.stopped,
      onError: (error) => this.report(error),
    });
    const { concurrency } = options;

    if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
      throw new Error("Daemon concurrency must be a positive integer. Supply at least one worker.");
    }

    this.pool = new ActivationPool(
      concurrency,
      (run) => this.activateRun(run),
      () => this.wake(),
    );
  }

  run(): Promise<void> {
    this.running ??= this.loop().finally(() => {
      this.running = undefined;
    });

    return this.running;
  }

  wake(): void {
    this.wakeController.abort();
  }

  async stop(): Promise<void> {
    this.status = "stopping";
    this.wake();
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
        delay = progress > 0 ? 1000 : Math.min(IDLE_CAP_MS, delay * 2);
      } catch (error) {
        this.report(error);
        await this.wait({ milliseconds: IDLE_CAP_MS });
      }
    }

    await this.pool.drain();
  }

  private async dueWork() {
    const time = this.clock.now();
    const now = new Date(time).toISOString();

    if (time >= this.nextPruneAt) {
      await this.options.store.pruneEvents(now);
      this.nextPruneAt = time + PRUNE_INTERVAL_MS;
    }

    const fired = await this.schedules.tick(now);
    const runs = await this.options.store.dueRuns(now);

    return { fired, runs };
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

      await activate({
        runId: run.id,
        store: this.options.store,
        clock: this.clock,
        ...prepared,
      });

      return true;
    } catch (error) {
      if (!(error instanceof StoreError && error.code === "owned_elsewhere")) {
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
        await store.apply({
          runId: run.id,
          token,
          effects: [
            {
              kind: "finish_run",
              outcome: { status: "failed", error: errorMessage(error) },
              at: new Date(this.clock.now()).toISOString(),
            },
          ],
        });
      } finally {
        await store.release(run.id, token);
      }

      this.report(error, run);

      return undefined;
    }
  }

  private report(cause: unknown, run?: RunRecord): void {
    const error = toError(cause);
    this.options.onError?.(error, run);
  }

  private async wait(delay: { milliseconds: number } | { minimum: number }): Promise<void> {
    const controller = this.wakeController;

    try {
      if (this.stopped || controller.signal.aborted) {
        return;
      }

      const milliseconds =
        "milliseconds" in delay ? delay.milliseconds : await this.waitDuration(delay.minimum);

      if (this.stopped) {
        return;
      }

      this.status = "waiting";
      await this.clock.sleep(milliseconds, controller.signal);
    } finally {
      if (!this.stopped) {
        this.status = "idle";
      }

      this.wakeController = new AbortController();
    }
  }

  private get stopped() {
    return this.status === "stopping";
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

    const idleCap = this.pool.active > 0 && minimum > 0 ? minimum : IDLE_CAP_MS;

    return Math.max(minimum, Math.min(idleCap, ...deadlines.map((at) => at - this.clock.now())));
  }
}
