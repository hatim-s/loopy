import { Deferred, Effect, Exit, Scope } from "effect";
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

/** A store whose every heartbeat reports the lease lost. */
export class LostLeaseStore extends MemorySqlStore {
  override heartbeat() {
    return Effect.succeed(false);
  }
}

/** A store whose release signals `releasing` and then never returns. */
export class StalledReleaseStore extends MemorySqlStore {
  constructor(private readonly releasing: Deferred.Deferred<void>) {
    super();
  }

  override release() {
    return Deferred.succeed(this.releasing, undefined).pipe(Effect.andThen(Effect.never));
  }
}

export function memoryStore(options: { leaseMs?: number } = {}) {
  return new MemorySqlStore(options);
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
