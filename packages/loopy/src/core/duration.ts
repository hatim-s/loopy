import { isNumber } from "./validation.js";

export type Duration = number | `${number}${"s" | "m" | "h" | "d"}`;

const UNITS = new Map([
  ["s", 1000],
  ["m", 60_000],
  ["h", 3_600_000],
  ["d", 86_400_000],
]);

export const DURATION_PATTERN = /^(\d+(?:\.\d+)?)([smhd])$/;

export function durationMs(duration: Duration): number {
  const match = isNumber(duration) ? null : DURATION_PATTERN.exec(duration);

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
