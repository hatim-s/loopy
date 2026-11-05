import { Deferred, Effect } from "effect";

// The latch wakes internal waits. Only foreign Docker calls receive its abort bridge.
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
  pause(ms: number) {
    return Effect.sleep(ms).pipe(Effect.raceFirst(Deferred.await(this.latch)));
  }
}
