import { requireRecord, requireString } from "../core/index.js";

export type RateLimits = Record<string, { count: number; windowMs: number }>;

export type RateLimitResult = { ok: true } | { ok: false; retryAt: string };

export type RateLimitWindow = { windowStart: string; count: number };

const UNITS = new Map([
  ["s", 1000],
  ["m", 60_000],
  ["h", 3_600_000],
  ["d", 86_400_000],
]);

// BOUNDARY: Home config values are untrusted JSON and must define positive counts and windows.
export function parseRateLimits(value: unknown): RateLimits {
  const entries = requireRecord(value, "Rate limits");

  return Object.fromEntries(
    Object.entries(entries).map(([key, value]) => {
      const match = /^(\d+)\/(\d+(?:\.\d+)?)([smhd])$/.exec(
        requireString(value, `Rate limit '${key}'`),
      );

      const count = Number(match?.[1]);
      const windowMs = Number(match?.[2]) * (UNITS.get(match?.[3] ?? "") ?? Number.NaN);

      if (
        !key ||
        !Number.isSafeInteger(count) ||
        count < 1 ||
        !Number.isSafeInteger(windowMs) ||
        windowMs < 1
      ) {
        throw new Error(
          `Rate limit '${key}' is invalid. Use a positive count and duration such as '10/1h' in config.json.`,
        );
      }

      return [key, { count, windowMs }];
    }),
  );
}

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
