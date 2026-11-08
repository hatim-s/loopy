import type { RateLimitResult } from "@loopy/core";
import type { SqlContext } from "./context";

type RateLimitWindow = { windowStart: string; count: number };

function acquireWindow(
  window: RateLimitWindow | undefined,
  count: number,
  windowMs: number,
  now: string,
) {
  const current =
    !window || Date.parse(now) >= Date.parse(window.windowStart) + windowMs
      ? { windowStart: new Date(now).toISOString(), count: 0 }
      : window;

  if (current.count >= count) {
    return {
      result: {
        ok: false,
        retryAt: new Date(Date.parse(current.windowStart) + windowMs).toISOString(),
      } satisfies RateLimitResult,
      window: current,
    };
  }

  return {
    result: { ok: true } satisfies RateLimitResult,
    window: { ...current, count: current.count + 1 },
  };
}

export function acquireRateLimit(
  ctx: SqlContext,
  limit: { key: string; count: number; windowMs: number; now: string },
) {
  const window =
    ctx.db
      .query<RateLimitWindow, [string]>(
        "SELECT window_start AS windowStart,count FROM rate_limits WHERE key=?",
      )
      .get(limit.key) ?? undefined;

  const acquired = acquireWindow(window, limit.count, limit.windowMs, limit.now);
  ctx.db
    .query(
      "INSERT INTO rate_limits VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET window_start=excluded.window_start,count=excluded.count",
    )
    .run(limit.key, acquired.window.windowStart, acquired.window.count);

  return acquired.result;
}
