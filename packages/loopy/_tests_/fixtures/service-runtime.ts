import { afterEach } from "bun:test";
import { type DaemonOptions, makeDaemon } from "@loopy/runtime/host";
import { makeSqliteRunStore, openRunStore } from "@loopy/runtime/store";
import { Clock, Effect, Exit, Scope } from "effect";

const scopes: Scope.Closeable[] = [];

afterEach(async () => {
  for (const scope of scopes.splice(0).reverse()) {
    await Effect.runPromise(Scope.close(scope, Exit.void));
  }
});

export function fixtureScope() {
  const scope = Scope.makeUnsafe();
  scopes.push(scope);

  return scope;
}

export const fixtureStore = (home: string) =>
  Effect.runPromise(openRunStore(home).pipe(Effect.provideService(Scope.Scope, fixtureScope())));

export const fixtureSqlite = (file: string, now = Date.now) =>
  Effect.runPromise(
    makeSqliteRunStore(file, now).pipe(Effect.provideService(Scope.Scope, fixtureScope())),
  );

export function fixtureDaemon(options: DaemonOptions & { clock: { now(): number } }) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const platform = yield* Clock.Clock;

      const clock: Clock.Clock = {
        sleep: (duration) => platform.sleep(duration),
        currentTimeNanosUnsafe: () => platform.currentTimeNanosUnsafe(),
        currentTimeNanos: platform.currentTimeNanos,
        monotonicTimeNanosUnsafe: () => platform.monotonicTimeNanosUnsafe(),
        monotonicTimeNanos: platform.monotonicTimeNanos,
        currentTimeMillisUnsafe: options.clock.now,
        currentTimeMillis: Effect.sync(options.clock.now),
      };

      const daemon = yield* makeDaemon(options);

      return { ...daemon, tick: daemon.tick.pipe(Effect.provideService(Clock.Clock, clock)) };
    }).pipe(Effect.provideService(Scope.Scope, fixtureScope())),
  );
}
