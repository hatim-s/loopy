import { ago, timestamp } from "../lib/format.ts";

const SAME_YEAR = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

const OTHER_YEAR = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** Second precision for this year, the year instead of seconds for anything older. */
function precise(value: string, now: number): string {
  const date = new Date(value);

  return date.getFullYear() === new Date(now).getFullYear()
    ? SAME_YEAR.format(date)
    : OTHER_YEAR.format(date);
}

/**
 * An exact local time with the relative age beside it, so rows can be compared and read. In a
 * narrow column the age drops out of view and stays in the tooltip. `relative` lifts the time
 * above a row link's overlay so that tooltip can show.
 */
export function TimeStamp({ at, now }: { at: string; now: number }) {
  const age = ago(at, now);

  return (
    <span className="@container block min-w-0">
      <time
        dateTime={at}
        title={`${timestamp(at)}, ${age}`}
        className="relative inline-flex max-w-full items-baseline gap-2 tabular-nums"
      >
        <span className="truncate font-mono text-xs">{precise(at, now)}</span>
        <span className="shrink-0 text-xs text-faint @max-[12.5rem]:hidden">{age}</span>
      </time>
    </span>
  );
}

const UNITS = [
  { size: 86_400_000, suffix: "d" },
  { size: 3_600_000, suffix: "h" },
  { size: 60_000, suffix: "m" },
] as const;

/** The largest whole unit only, for lists too narrow for "3h 10m ago": 45s, 12m, 3h, 2d. */
export function shortAge(value: string, now: number): string {
  const elapsed = Math.max(0, now - Date.parse(value));
  const unit = UNITS.find(({ size }) => elapsed >= size);

  return unit
    ? `${Math.floor(elapsed / unit.size)}${unit.suffix}`
    : `${Math.floor(elapsed / 1000)}s`;
}
