import type { EngineStep } from "../core/index.js";

export class Activation {
  running = 0;
  blocked = 0;
  finished = 0;
  fatal?: Error;
  wakeAt?: string;
  private finishOrder: number;
  private readonly replays: { finishOrder: number; deliver: () => void }[] = [];

  constructor(steps: EngineStep[]) {
    this.finishOrder = Math.max(
      0,
      ...steps.map((step) =>
        step.status === "succeeded" || step.status === "failed" ? step.finishOrder : 0,
      ),
    );
  }

  finish(): number {
    this.finished++;

    return ++this.finishOrder;
  }

  queue<T>(finishOrder: number, deliver: () => T): Promise<T> {
    return new Promise((resolve, reject) => {
      this.replays.push({
        finishOrder,
        deliver: () => {
          this.finished++;

          try {
            resolve(deliver());
          } catch (cause) {
            reject(cause);
          }
        },
      });
    });
  }

  deliverReplay(): boolean {
    this.replays.sort((a, b) => a.finishOrder - b.finishOrder);
    const replay = this.replays.shift();
    replay?.deliver();

    return replay !== undefined;
  }

  block(wakeAt: string): Promise<never> {
    this.blocked++;

    if (this.wakeAt === undefined || wakeAt < this.wakeAt) {
      this.wakeAt = wakeAt;
    }

    return new Promise(() => {});
  }

  tick(): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  }
}
