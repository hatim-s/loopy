import { Deferred, Effect, Result } from "effect";
import { SandboxRequestError } from "./request-error";

export function stoppingConflict() {
  return new SandboxRequestError("conflict", "Sandbox service is stopping. Retry after restart.");
}

export class Stopping {
  private readonly controller = new AbortController();
  private constructor(private readonly latch: Deferred.Deferred<void>) {}
  static make() {
    return Deferred.make<void>().pipe(Effect.map((latch) => new Stopping(latch)));
  }
  get stopped() {
    return Deferred.isDoneUnsafe(this.latch);
  }
  get signal() {
    return this.controller.signal;
  }
  stop() {
    return Deferred.succeed(this.latch, undefined).pipe(
      Effect.tap(() => Effect.sync(() => this.controller.abort())),
      Effect.asVoid,
    );
  }
  retry<A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, SandboxRequestError> {
    return Effect.gen({ self: this }, function* () {
      let backoff = 100;

      while (!this.stopped) {
        const result = yield* Effect.result(effect);

        if (Result.isSuccess(result)) {
          return result.success;
        }

        yield* Effect.sleep(backoff).pipe(Effect.raceFirst(Deferred.await(this.latch)));
        backoff = Math.min(backoff * 2, 5000);
      }

      return yield* Effect.fail(stoppingConflict());
    });
  }
}
