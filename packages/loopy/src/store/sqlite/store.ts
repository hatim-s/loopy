import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Store } from "../../core/index.js";
import { SqliteQueryFeeds } from "./query-feeds.js";

export class SqliteRunStore extends SqliteQueryFeeds implements Store {}

export function openRunStore(home: string, options: { leaseMs?: number } = {}) {
  mkdirSync(home, { recursive: true, mode: 0o700 });

  return new SqliteRunStore(join(home, "runs.sqlite"), Date.now, options);
}
