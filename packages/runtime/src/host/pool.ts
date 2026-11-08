import type { RunRecord } from "@loopy/core";
import { Effect, Fiber, type Scope } from "effect";

export class ActivationPool {
  private readonly pending = new Map<string, Fiber.Fiber<unknown, unknown>>();

  constructor(
    private readonly concurrency: number,
    private readonly activate: (run: RunRecord) => Effect.Effect<unknown, unknown>,
  ) {}

  start(run: RunRecord): Effect.Effect<void, never, Scope.Scope> {
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
        Effect.forkScoped({ startImmediately: false }),
      );

      this.pending.set(run.id, fiber);
    });
  }

  get active() {
    return this.pending.size;
  }

  // Waits for every admitted activation to end. Each activation reports its own failures.
  drain() {
    return Effect.forEach([...this.pending.values()], Fiber.await, {
      concurrency: "unbounded",
      discard: true,
    });
  }
}
