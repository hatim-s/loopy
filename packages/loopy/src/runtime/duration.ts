import { type Duration, isNumber } from "../core/index.js";

export type { Duration } from "../core/index.js";

const UNITS = new Map([
  ["s", 1000],
  ["m", 60_000],
  ["h", 3_600_000],
  ["d", 86_400_000],
]);

const DURATION = /^(\d+(?:\.\d+)?)([smhd])$/;

export function durationMs(duration: Duration): number {
  const match = isNumber(duration) ? null : DURATION.exec(duration);

  const multiplier = UNITS.get(match?.[2] ?? "");

  const milliseconds = isNumber(duration)
    ? duration
    : Number(match?.[1]) * (multiplier ?? Number.NaN);

  if (!Number.isFinite(milliseconds) || milliseconds < 0) {
    throw new Error(
      `Duration '${duration}' is invalid. Use nonnegative milliseconds or a duration such as '30s'.`,
    );
  }

  return milliseconds;
}
