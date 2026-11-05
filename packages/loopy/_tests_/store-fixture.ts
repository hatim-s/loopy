import { Effect, Exit, Scope } from "effect";
import { makeSqliteRunStore, type SqliteRunStore } from "../src/store/sqlite/store.js";

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

  const openTestStore = (
    file: string,
    now: () => number = Date.now,
    options: { leaseMs?: number } = {},
  ) => {
    const scope = Scope.makeUnsafe();

    const store = Effect.runSync(
      makeSqliteRunStore(file, now, options).pipe(Effect.provideService(Scope.Scope, scope)),
    );

    scopes.set(store, scope);

    return store;
  };

  return { openTestStore, closeTestStore, closeTestStores };
}
