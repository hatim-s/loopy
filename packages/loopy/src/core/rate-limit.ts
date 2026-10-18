import type { Duration } from "./duration.js";

export type RateLimit = { key: string; limit: number; window: Duration };

export type RateLimitResult = { ok: true } | { ok: false; retryAt: string };

export type RateLimitWindow = { windowStart: string; count: number };

export function acquireWindow(
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
