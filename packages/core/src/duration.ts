import { Schema } from "effect";
import { isNumber, isString } from "./validation";

export type Duration = number | `${number}${"s" | "m" | "h" | "d"}`;

const UNITS = new Map([
  ["s", 1000],
  ["m", 60_000],
  ["h", 3_600_000],
  ["d", 86_400_000],
]);

const DURATION = /^(\d+(?:\.\d+)?)([smhd])$/;

// BOUNDARY: Durations arrive as JSON numbers or unit-suffixed strings.
export const durationSchema = Schema.declare<Duration>((value): value is Duration =>
  isNumber(value) ? Number.isFinite(value) && value >= 0 : isString(value) && DURATION.test(value),
);

/**
 * Timeouts and rate-limit windows become whole positive milliseconds, the only budget the
 * process layer accepts, so a zero or sub-millisecond value fails when the graph is validated.
 */
export const positiveDurationSchema = durationSchema.check(
  Schema.makeFilter(
    (value) => {
      const milliseconds = durationMs(value);

      return Number.isSafeInteger(milliseconds) && milliseconds > 0;
    },
    { message: "Supply a duration of at least 1 ms in whole milliseconds, such as 1500 or '30s'." },
  ),
);

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
