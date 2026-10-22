import type { Store } from "../core/index.js";
import { SqliteQueryFeeds } from "./sqlite/query-feeds.js";

export type { SqlDriver, SqlStatement, SqlTransactionMode, SqlValue } from "./sqlite/driver.js";

export type { SqlOwnerPolicy, SqlStoreOptions } from "./sqlite/owner-policy.js";

export class SqlRunStore extends SqliteQueryFeeds implements Store {}
