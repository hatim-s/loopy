import { timestamp, until } from "../lib/format";

export function Countdown({ at, now }: { at: string; now: number }) {
  return (
    <time dateTime={at} title={timestamp(at)} className="tabular-nums">
      {until(at, now)}
    </time>
  );
}
