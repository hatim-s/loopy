import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { StoreService } from "@loopy/core";
import { Effect, Layer } from "effect";
import { storageOperation } from "../operation";
import { SqlRunStore } from "../portable";
import { BunSqlDriver } from "./bun-driver";
import { localOwnerPolicy } from "./local-owner";
import { initializeLocalSchema } from "./local-schema";

class LocalSqlStore extends SqlRunStore {
  constructor(file: string, now: () => number = Date.now, options: { leaseMs?: number } = {}) {
    const db = new BunSqlDriver(file);

    try {
      initializeLocalSchema(db);
      super(db, { ...options, now, owner: localOwnerPolicy() });
    } catch (error) {
      db.close();
      throw error;
    }
  }

  dataVersion() {
    return storageOperation(
      "dataVersion",
      () =>
        this.db.query<{ data_version: number }, []>("PRAGMA data_version").get()?.data_version ?? 0,
    );
  }
}

export type SqliteRunStore = LocalSqlStore;

export function openRunStore(home: string, options: { leaseMs?: number } = {}) {
  return Effect.gen(function* () {
    yield* storageOperation("prepareHome", () => mkdirSync(home, { recursive: true, mode: 0o700 }));

    return yield* makeSqliteRunStore(join(home, "runs.sqlite"), Date.now, options);
  });
}

export const makeSqliteRunStore = (
  file: string,
  now: () => number = Date.now,
  options: { leaseMs?: number } = {},
) =>
  Effect.acquireRelease(
    storageOperation("open", () => new LocalSqlStore(file, now, options)),
    (store) => store.close().pipe(Effect.orDie),
  );

// Reuse this layer value throughout one daemon build to share one connection.
export const sqliteStoreLayer = (file: string, options: { leaseMs?: number } = {}) =>
  Layer.effect(StoreService, makeSqliteRunStore(file, Date.now, options));
