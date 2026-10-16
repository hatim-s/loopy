import type { EngineRun } from "../core/index.js";

export class ActivationPool {
  private readonly pending = new Map<string, Promise<boolean>>();
  private progress = 0;

  constructor(
    private readonly concurrency: number,
    private readonly activate: (run: EngineRun) => Promise<boolean>,
    private readonly onProgress: () => void,
  ) {}

  start(run: EngineRun): Promise<boolean> | undefined {
    if (this.pending.has(run.id) || this.pending.size >= this.concurrency) {
      return undefined;
    }

    const activation = this.activate(run).then((progress) => {
      this.pending.delete(run.id);

      if (progress) {
        this.progress++;
        this.onProgress();
      }

      return progress;
    });

    this.pending.set(run.id, activation);

    return activation;
  }

  async activateAll(runs: EngineRun[]): Promise<number> {
    let activated = 0;
    let pending: Promise<boolean>[] = [];

    for (const run of runs) {
      if (this.pending.has(run.id)) {
        continue;
      }

      let activation = this.start(run);

      if (!activation) {
        activated += (await Promise.all(pending)).filter(Boolean).length;
        pending = [];
        await this.drain();
        activation = this.start(run);
      }

      if (activation) {
        pending.push(activation);
      }
    }

    return activated + (await Promise.all(pending)).filter(Boolean).length;
  }

  get active(): number {
    return this.pending.size;
  }

  takeProgress(): number {
    const progress = this.progress;
    this.progress = 0;

    return progress;
  }

  async drain(): Promise<void> {
    await Promise.all(this.pending.values());
  }
}
