import { isTerminalRun, type RunView } from "@loopy/contract";

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

export function elapsed(ms: number): string {
  if (ms < 1000) {
    return `${Math.max(0, Math.round(ms))}ms`;
  }

  return ms < 10_000 ? `${(ms / 1000).toFixed(1)}s` : span(ms);
}

/** How long a run took, or has taken so far. Terminal runs end at their last update. */
export function runElapsed(run: RunView, now: number): number {
  return (isTerminalRun(run.status) ? Date.parse(run.updatedAt) : now) - Date.parse(run.createdAt);
}

export function until(at: string, now: number): string {
  const remaining = Date.parse(at) - now;

  return remaining > 0 ? `in ${span(remaining)}` : "due now";
}

export function bytes(count: number): string {
  if (count < 1024) {
    return `${count} B`;
  }

  return count < 1_048_576
    ? `${(count / 1024).toFixed(1)} KB`
    : `${(count / 1_048_576).toFixed(1)} MB`;
}

export function timestamp(value: string): string {
  return new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "medium" });
}

export function clockTime(value: string): string {
  return new Date(value).toLocaleTimeString(undefined, { hour12: false });
}

const PRECISE_TIME = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  fractionalSecondDigits: 3,
  hourCycle: "h23",
});

/** Wall-clock time to the millisecond, for ordering log lines and events that share a second. */
export function preciseTime(at: string): string {
  return PRECISE_TIME.format(new Date(at));
}

// Daemon run ids are UUIDs, so eight characters identify one on a page. Other ids show whole.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-/i;

export function shortId(id: string): string {
  return UUID.test(id) ? id.slice(0, 8) : id;
}

export function ago(value: string, now: number): string {
  return `${span(now - Date.parse(value))} ago`;
}

export function countTotal(counts: Record<string, number>): number {
  return Object.values(counts).reduce((sum, count) => sum + count, 0);
}
