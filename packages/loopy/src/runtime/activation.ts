import type { EngineStep, RunOutcome } from "../core/index.js";

type Delivery = { finishOrder: number; source: "memoized" | "live"; deliver: () => void };

export class Activation {
  running = 0;
  blocked = 0;
  finished = 0;
  fatal?: Error;
  outcome?: RunOutcome;
  wakeAt?: string;
  closed = false;
  private invoking = false;
  private visited = 0;
  private readonly highestStored: number;
  private writes: Promise<number>;
  private readonly deliveries: Delivery[] = [];
  private resolveChange = () => {};
  changed = this.nextChange();

  constructor(steps: EngineStep[]) {
    this.highestStored = Math.max(0, ...steps.map((step) => step.seq));

    const finishOrder = Math.max(
      0,
      ...steps.map((step) =>
        step.status === "succeeded" || step.status === "failed" ? step.finishOrder : 0,
      ),
    );

    this.writes = Promise.resolve(finishOrder);
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
    if (this.invoking) {
      const error = new Error("Steps cannot be nested. Call steps from the workflow instead.");
      this.fail(error);
      throw error;
    }

    if (this.closed) {
      throw new Error(
        "Activation is closed. Await all branches before returning from the workflow.",
      );
    }
  }

  invoke<T>(fn: () => T): T {
    this.invoking = true;

    try {
      return fn();
    } finally {
      this.invoking = false;
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

  block(wakeAt: string): Promise<never> {
    this.blocked++;

    if (this.wakeAt === undefined || wakeAt < this.wakeAt) {
      this.wakeAt = wakeAt;
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
