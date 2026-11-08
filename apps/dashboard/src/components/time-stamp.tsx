import { ago, timestamp } from "../lib/format";

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
