import { isNumber } from "../core/index.js";

export type Duration = number | `${number}${"s" | "m" | "h" | "d"}`;

const UNITS = new Map([
  ["s", 1000],
  ["m", 60_000],
  ["h", 3_600_000],
  ["d", 86_400_000],
]);

export function durationMs(duration: Duration): number {
  const milliseconds = isNumber(duration) ? duration : parseDuration(duration);

  if (!Number.isFinite(milliseconds) || milliseconds < 0) {
    throw new Error(
      "Duration must be finite and nonnegative. Use milliseconds or a duration such as '30s'.",
    );
  }

  return milliseconds;
}

function parseDuration(duration: string): number {
  const match = /^(\d+(?:\.\d+)?)([smhd])$/.exec(duration);
  const unit = match?.[2];
  const multiplier = unit === undefined ? undefined : UNITS.get(unit);

  if (!match || multiplier === undefined) {
    throw new Error("Duration is invalid. Use milliseconds or a duration such as '30s'.");
  }

  return Number(match[1]) * multiplier;
}
