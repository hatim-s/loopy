/** A span of milliseconds at the precision a person reads: 42s, 3m 5s, 2h 10m. */
export function span(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));

  if (seconds < 60) {
    return `${seconds}s`;
  }

  const minutes = Math.floor(seconds / 60);

  return minutes < 60
    ? `${minutes}m ${seconds % 60}s`
    : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function duration(start: string, end: number): string {
  return span(end - Date.parse(start));
}

export function timestamp(value: string): string {
  return new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "medium" });
}

/** Wall-clock time only, for log lines where the date is already on the page. */
export function clockTime(value: string): string {
  return new Date(value).toLocaleTimeString(undefined, { hour12: false });
}

/** How long ago a moment was, against a clock the caller owns: "42s ago", "3h 10m ago". */
export function ago(value: string, now: number): string {
  return `${span(now - Date.parse(value))} ago`;
}
