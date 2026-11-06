import { Effect, Fiber, type Scope } from "effect";
import type { RunRecord } from "../core";

/** The caller's scope owns every admitted activation. Membership outlives completion until cleanup. */
export class ActivationPool<E = never> {
  private readonly pending = new Map<string, Fiber.Fiber<boolean, E>>();
  private progress = 0;
  constructor(
    private readonly concurrency: number,
    private readonly activate: (run: RunRecord) => Effect.Effect<boolean, E>,
    private readonly onProgress: () => void,
  ) {}

  start(run: RunRecord): Effect.Effect<Fiber.Fiber<boolean, E> | undefined, never, Scope.Scope> {
    return Effect.gen({ self: this }, function* () {
      if (this.pending.has(run.id) || this.pending.size >= this.concurrency) {
        return;
      }

      const fiber = yield* this.activate(run).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            this.pending.delete(run.id);
          }),
        ),
        Effect.tap((progress) =>
          Effect.sync(() => {
            if (progress) {
              this.progress++;
              this.onProgress();
            }
          }),
        ),
        Effect.forkScoped({ startImmediately: false }),
      );

      this.pending.set(run.id, fiber);

      return fiber;
    });
  }

  has(runId: string) {
    return this.pending.has(runId);
  }
  fibers() {
    return [...this.pending.values()];
  }
  get active() {
    return this.pending.size;
  }
  takeProgress() {
    const progress = this.progress;
    this.progress = 0;

    return progress;
  }
  drain() {
    return Effect.forEach([...this.pending.values()], Fiber.join, {
      concurrency: "unbounded",
      discard: true,
    });
  }
}
