import type { HookRecord, RunOutcome, StepRecord } from "../core/index.js";

type HookWait = { wakeAt?: string; deliver: (hook: HookRecord) => void };

type Delivery = { finishOrder: number; source: "memoized" | "live"; deliver: () => void };

export class Activation {
  running = 0;
  blocked = 0;
  finished = 0;
  fatal?: Error;
  outcome?: RunOutcome;
  private blockedWakeAt?: string;
  private readonly hooks = new Map<number, HookWait>();
  private nextHookPollAt = 0;

  closed = false;
  private visited = 0;
  private readonly highestStored: number;
  private writes: Promise<number>;
  private readonly deliveries: Delivery[] = [];
  private resolveChange = () => {};
  changed = this.nextChange();

  constructor(steps: StepRecord[]) {
    this.highestStored = Math.max(0, ...steps.map((step) => step.seq));

    const finishOrder = Math.max(
      0,
      ...steps.map((step) =>
        step.status === "succeeded" || step.status === "failed" ? step.finishOrder : 0,
      ),
    );

    this.writes = Promise.resolve(finishOrder);
  }

  get wakeAt(): string | undefined {
    const deadlines = [...this.hooks.values()].flatMap((hook) =>
      hook.wakeAt === undefined ? [] : [hook.wakeAt],
    );

    if (this.blockedWakeAt !== undefined) {
      deadlines.push(this.blockedWakeAt);
    }

    return deadlines.sort()[0];
  }

  get waitingForHooks(): boolean {
    return this.hooks.size > 0;
  }

  waitForHook(seq: number, wakeAt?: string): Promise<HookRecord> {
    if (!this.waitingForHooks) {
      this.nextHookPollAt = Date.now() + 100;
    }

    this.blocked++;

    return new Promise((resolve) => {
      this.hooks.set(seq, {
        wakeAt,
        deliver: (hook) => {
          // Count the terminal write before the driver can decide this activation is idle.
          this.start();
          resolve(hook);
        },
      });
      this.notify();
    });
  }

  hooksToPoll(): number[] {
    if (Date.now() < this.nextHookPollAt) {
      return [];
    }

    this.nextHookPollAt = Date.now() + 100;

    return [...this.hooks.keys()];
  }

  resolveHooks(hooks: HookRecord[], now: number): void {
    for (const hook of hooks) {
      const waiting = this.hooks.get(hook.seq);
      const expired = waiting?.wakeAt !== undefined && Date.parse(waiting.wakeAt) <= now;

      if (waiting && (hook.resolvedAt !== undefined || expired)) {
        this.hooks.delete(hook.seq);
        this.blocked--;
        waiting.deliver(hook);
      }
    }
  }

  async waitForChange(): Promise<void> {
    if (!this.waitingForHooks || this.running === 0) {
      return this.changed;
    }

    // Signals come from other processes, so active branches must also check the store.
    const timer = setTimeout(() => this.notify(), Math.max(0, this.nextHookPollAt - Date.now()));

    try {
      await this.changed;
    } finally {
      clearTimeout(timer);
    }
  }

  private nextChange(): Promise<void> {
    return new Promise((resolve) => {
      this.resolveChange = resolve;
    });
  }

  notify(): void {
    this.resolveChange();
    this.changed = this.nextChange();
  }

  fail(error: Error): void {
    this.fatal ??= error;
    this.close();
  }

  assertOpen(): void {
    if (this.closed) {
      throw new Error(
        "Activation is closed. Await all branches before returning from the workflow.",
      );
    }
  }

  visit(seq: number): void {
    this.visited = seq;
    this.notify();
  }

  start(): void {
    this.running++;
    this.notify();
  }

  end(): void {
    this.running--;
    this.notify();
  }

  close(): void {
    this.closed = true;
    this.notify();
  }

  complete(outcome: RunOutcome): void {
    this.outcome = outcome;
    this.close();
  }

  terminal(write: (finishOrder: number) => Promise<void>): Promise<number> {
    const pending = this.writes.then(async (order) => {
      const next = order + 1;

      await write(next);

      return next;
    });

    this.writes = pending;

    return pending;
  }

  queue<T>(finishOrder: number, source: "memoized" | "live", deliver: () => T): Promise<T> {
    return new Promise((resolve, reject) => {
      this.deliveries.push({
        finishOrder,
        source,
        deliver: () => {
          this.finished++;

          try {
            resolve(deliver());
          } catch (cause) {
            reject(cause);
          }
        },
      });
      this.notify();
    });
  }

  deliver(): boolean {
    this.deliveries.sort((a, b) => a.finishOrder - b.finishOrder);
    const next = this.deliveries[0];

    if (
      !next ||
      (!this.closed &&
        next.source === "live" &&
        (this.visited < this.highestStored ||
          this.deliveries.some((entry) => entry.source === "memoized")))
    ) {
      return false;
    }

    this.deliveries.shift();
    next.deliver();
    this.notify();

    return true;
  }

  block(wakeAt?: string): Promise<never> {
    this.blocked++;

    if (wakeAt !== undefined && (this.blockedWakeAt === undefined || wakeAt < this.blockedWakeAt)) {
      this.blockedWakeAt = wakeAt;
    }

    this.notify();

    return new Promise(() => {});
  }

  tick(): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  }
}
