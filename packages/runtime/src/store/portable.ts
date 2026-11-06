import { StoreService } from "@loopy/core";
import { Layer } from "effect";
import { storageOperation } from "./operation";
import type { SqlDriver } from "./sqlite/driver";
import type { SqlStoreOptions } from "./sqlite/owner-policy";
import { SqlRunStore } from "./sqlite/query/feeds";

export type { SqlDriver, SqlStatement, SqlTransactionMode, SqlValue } from "./sqlite/driver";

export type { SqlOwnerPolicy, SqlStoreOptions } from "./sqlite/owner-policy";

export { SqlRunStore } from "./sqlite/query/feeds";

// The caller owns the portable connection, including DO eviction and disposal.
export const makeSqlRunStore = (driver: SqlDriver, options: SqlStoreOptions) =>
  storageOperation("open", () => new SqlRunStore(driver, options));

export const sqlStoreLayer = (driver: SqlDriver, options: SqlStoreOptions) =>
  Layer.effect(StoreService, makeSqlRunStore(driver, options));
