import { Layer } from "effect";
import { StoreService } from "../core/index.js";
import { storageOperation } from "./operation.js";
import type { SqlDriver } from "./sqlite/driver.js";
import type { SqlStoreOptions } from "./sqlite/owner-policy.js";
import { SqlRunStore } from "./sqlite/query-feeds.js";

export type { SqlDriver, SqlStatement, SqlTransactionMode, SqlValue } from "./sqlite/driver.js";

export type { SqlOwnerPolicy, SqlStoreOptions } from "./sqlite/owner-policy.js";

export { SqlRunStore } from "./sqlite/query-feeds.js";

// The caller owns the portable connection, including DO eviction and disposal.
export const makeSqlRunStore = (driver: SqlDriver, options: SqlStoreOptions) =>
  storageOperation("open", () => new SqlRunStore(driver, options));

export const sqlStoreLayer = (driver: SqlDriver, options: SqlStoreOptions) =>
  Layer.effect(StoreService, makeSqlRunStore(driver, options));
