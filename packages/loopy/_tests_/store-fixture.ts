import { type SqlOwnerPolicy, SqlRunStore } from "@loopy/runtime/store/portable";
import { Clock, Effect, Exit, Scope } from "effect";
import { BunSqlDriver } from "../../runtime/src/store/sqlite/bun-driver";
import { makeSqliteRunStore, type SqliteRunStore } from "../../runtime/src/store/sqlite/store";

// No owner is alive, so a lease expires on time alone, as it does for cloud owners.
export const NEVER_ALIVE: SqlOwnerPolicy = {
  identity: { pid: 0, host: "test" },
  isAlive: () => false,
};

/** A private in-memory SQLite store. Subclass it to observe or fail one store method. */
export class MemorySqlStore extends SqlRunStore {
  constructor(options: { leaseMs?: number } = {}) {
    super(new BunSqlDriver(":memory:"), { owner: NEVER_ALIVE, ...options });
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

export function createTestStores() {
  const scopes = new Map<SqliteRunStore, Scope.Closeable>();

  const closeTestStore = (store: SqliteRunStore) => {
    const scope = scopes.get(store);

    if (scope) {
      scopes.delete(store);
      Effect.runSync(Scope.close(scope, Exit.void));
    }
  };

  const closeTestStores = () => {
    for (const store of [...scopes.keys()].reverse()) {
      closeTestStore(store);
    }
  };

  const openTestStore = (file: string, options: { leaseMs?: number } = {}) => {
    const scope = Scope.makeUnsafe();

    const store = Effect.runSync(
      makeSqliteRunStore(file, options).pipe(Effect.provideService(Scope.Scope, scope)),
    );

    scopes.set(store, scope);

    return store;
  };

  return { openTestStore, closeTestStore, closeTestStores };
}
