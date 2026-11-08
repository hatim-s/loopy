import { Clock, Effect, Exit, Scope } from "effect";
import { makeSqliteRunStore } from "../../src/store";
import { BunSqlDriver } from "../../src/store/bun-driver";
import { type SqlOwnerPolicy, SqlRunStore } from "../../src/store/portable";
import { fixtureScope } from "./test-scope";

// No owner is alive, so a lease expires on time alone, as it does for cloud owners.
export const NEVER_ALIVE: SqlOwnerPolicy = {
  identity: { pid: 0, host: "test" },
  isAlive: () => false,
};

/** A private in-memory SQLite store. Subclass it to observe or fail one store method. */
export class MemorySqlStore extends SqlRunStore {
  /** Seeds rows that would take too long to commit one write at a time. */
  readonly driver: BunSqlDriver;

  constructor(options: { leaseMs?: number } = {}) {
    const driver = new BunSqlDriver(":memory:");
    super(driver, { owner: NEVER_ALIVE, ...options });
    this.driver = driver;
  }
}

export function memoryStore(options: { leaseMs?: number } = {}) {
  return new MemorySqlStore(options);
}

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

const scopes = new WeakMap<SqlRunStore, Scope.Closeable>();

/** A local store as the daemon opens it. It closes with the test unless closeTestStore runs first. */
export function openTestStore(file: string, options: { leaseMs?: number } = {}) {
  const scope = Scope.forkUnsafe(fixtureScope());

  const store = Effect.runSync(
    makeSqliteRunStore(file, options).pipe(Effect.provideService(Scope.Scope, scope)),
  );

  scopes.set(store, scope);

  return store;
}

/** Closes a store early, so the test can reopen its file. */
export function closeTestStore(store: SqlRunStore) {
  const scope = scopes.get(store);

  if (scope) {
    Effect.runSync(Scope.close(scope, Exit.void));
  }
}
