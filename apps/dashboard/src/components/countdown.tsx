import { span, timestamp } from "../lib/format.ts";

/** "in 4m 10s" until the moment passes, then "due now". The caller owns the clock. */
export function Countdown({ at, now }: { at: string; now: number }) {
  const remaining = Date.parse(at) - now;

  return (
    <time dateTime={at} title={timestamp(at)} className="tabular-nums">
      {remaining > 0 ? `in ${span(remaining)}` : "due now"}
    </time>
  );
}
