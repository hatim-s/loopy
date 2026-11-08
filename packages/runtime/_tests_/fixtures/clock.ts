import { Clock, Effect } from "effect";

// This module imports nothing from bun:test, so workerd probes can use it too.

/** Stores and hosts read time from Effect's Clock, so a test that moves time by hand provides this one. */
export function fixedClock(now: () => number): Clock.Clock {
  const platform = Effect.runSync(Clock.Clock);

  return {
    currentTimeMillisUnsafe: now,
    currentTimeMillis: Effect.sync(now),
    currentTimeNanosUnsafe: () => BigInt(now()) * 1_000_000n,
    currentTimeNanos: Effect.sync(() => BigInt(now()) * 1_000_000n),
    monotonicTimeNanosUnsafe: () => platform.monotonicTimeNanosUnsafe(),
    monotonicTimeNanos: platform.monotonicTimeNanos,
    sleep: (duration) => platform.sleep(duration),
  };
}

export function runAt(now: () => number) {
  const clock = fixedClock(now);

  return <A, E>(effect: Effect.Effect<A, E>) =>
    Effect.runPromise(effect.pipe(Effect.provideService(Clock.Clock, clock)));
}
