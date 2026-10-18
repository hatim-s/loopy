import type { RunRecord } from "../core/index.js";

export class ActivationPool {
  private readonly pending = new Map<string, Promise<boolean>>();
  private progress = 0;

  constructor(
    private readonly concurrency: number,
    private readonly activate: (run: RunRecord) => Promise<boolean>,
    private readonly onProgress: () => void,
  ) {}

  start(run: RunRecord): Promise<boolean> | undefined {
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
