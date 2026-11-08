import { describeCron } from "@loopy/contract";
import { timestamp, until } from "../../lib/format";

export function CronReading({ cron, tz }: { cron: string; tz?: string }) {
  const reading = describeCron(cron);

  return (
    <span className="block min-w-0" title={tz}>
      {reading && <span className="cell-main font-normal">{reading}</span>}
      <code className={`block truncate ${reading ? "text-muted" : "text-ink"}`}>{cron}</code>
    </span>
  );
}

const TIME = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

const DAY_TIME = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

export function FireTime({ at, now }: { at: string; now: number }) {
  const ms = Date.parse(at) - now;
  const date = new Date(at);

  return (
    <time dateTime={at} title={timestamp(at)} className="block tabular-nums">
      <span className="block">{ms < 86_400_000 ? TIME.format(date) : DAY_TIME.format(date)}</span>
      <span className="block text-xs text-muted">{until(at, now)}</span>
    </time>
  );
}
