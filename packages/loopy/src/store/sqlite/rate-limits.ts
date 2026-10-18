import type { Database } from "bun:sqlite";
import {
  acquireWindow,
  durationMs,
  type RateLimit,
  type RateLimitWindow,
} from "../../core/index.js";

export async function acquireRateLimit(db: Database, rule: RateLimit, now: string) {
  return db
    .transaction(() => {
      const window =
        db
          .query<RateLimitWindow, [string]>(
            "SELECT window_start AS windowStart,count FROM rate_limits WHERE key=?",
          )
          .get(rule.key) ?? null;

      const acquired = acquireWindow(
        window,
        { limit: rule.limit, windowMs: durationMs(rule.window) },
        now,
      );

      db.query(
        "INSERT INTO rate_limits VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET window_start=excluded.window_start,count=excluded.count",
      ).run(rule.key, acquired.window.windowStart, acquired.window.count);

      return acquired.result;
    })
    .immediate();
}
