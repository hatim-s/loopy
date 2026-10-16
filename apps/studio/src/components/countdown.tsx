import { useClock } from "../hooks/use-clock.ts";
import { timestamp } from "../lib/format.ts";

export function Countdown({ at, label }: { at: string; label: string }) {
  const now = useClock();
  const seconds = Math.max(0, Math.ceil((Date.parse(at) - now) / 1000));

  return (
    <p className="timer">
      {label} <time dateTime={at}>{timestamp(at)}</time> ·{" "}
      {seconds > 0 ? `in ${seconds}s` : "due now"}
    </p>
  );
}
