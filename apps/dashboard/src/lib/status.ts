import type { NodeRunView, RunStatus, RunView } from "@loopy/contract";

export type NodeRunStatus = NodeRunView["status"];

/**
 * Every state a pill can name. Runs, node executions and schedules share one vocabulary, so a
 * failed run and a failed node read the same everywhere. `awaiting` is a suspended run held on
 * a hook; `sleeping` is one held on a clock.
 */
export type Status =
  | Exclude<RunStatus, "suspended">
  | NodeRunStatus
  | "awaiting"
  | "suspended"
  | "active"
  | "paused";

export type Tone = "ok" | "bad" | "warn" | "blue" | "neutral";

export type Glyph =
  | "succeeded"
  | "failed"
  | "running"
  | "ring"
  | "cancelled"
  | "hourglass"
  | "retrying"
  | "paused"
  | "active";

export const STATUS = {
  succeeded: { tone: "ok", glyph: "succeeded", word: "Succeeded" },
  failed: { tone: "bad", glyph: "failed", word: "Failed" },
  running: { tone: "blue", glyph: "running", word: "Running" },
  queued: { tone: "neutral", glyph: "ring", word: "Queued" },
  cancelled: { tone: "neutral", glyph: "cancelled", word: "Cancelled" },
  skipped: { tone: "neutral", glyph: "cancelled", word: "Skipped" },
  awaiting: { tone: "warn", glyph: "hourglass", word: "Awaiting" },
  waiting: { tone: "warn", glyph: "hourglass", word: "Waiting" },
  sleeping: { tone: "warn", glyph: "hourglass", word: "Sleeping" },
  suspended: { tone: "neutral", glyph: "paused", word: "Suspended" },
  rate_limited: { tone: "warn", glyph: "hourglass", word: "Rate limited" },
  retrying: { tone: "warn", glyph: "retrying", word: "Retrying" },
  active: { tone: "ok", glyph: "active", word: "Active" },
  paused: { tone: "neutral", glyph: "paused", word: "Paused" },
} as const satisfies Record<Status, { tone: Tone; glyph: Glyph; word: string }>;

export function isStatus(value: string): value is Status {
  return Object.hasOwn(STATUS, value);
}

/**
 * A suspended run is awaiting a person when it holds a hook, sleeping when a clock will wake it,
 * and plainly suspended when neither holds it.
 */
export function runStatus(run: RunView): Status {
  if (run.status === "suspended") {
    if (run.waitingOn !== null) {
      return "awaiting";
    }

    return run.wakeAt === null ? "suspended" : "sleeping";
  }

  return run.status;
}

export function statusWord(status: Status): string {
  return STATUS[status].word;
}

export function statusTone(status: Status): Tone {
  return STATUS[status].tone;
}

/** The background colour of a tone, for marks that are not pills: dots and gutter rails. */
export const TONE_BG = {
  ok: "bg-success",
  bad: "bg-danger",
  warn: "bg-attention",
  blue: "bg-active",
  neutral: "bg-neutral",
} as const satisfies Record<Tone, string>;

// Inline fills, for drawings that take colours as values rather than classes.
export const TONE_FILL = {
  ok: "var(--success)",
  bad: "var(--danger)",
  warn: "var(--attention)",
  blue: "var(--lamp)",
  neutral: "var(--neutral)",
} as const satisfies Record<Tone, string>;

/**
 * How node executions compare. The lowest rank is the most urgent, so a node or map item with
 * many executions shows its worst one. A settled execution will not change again.
 */
const NODE_STATUS = {
  failed: { rank: 0, settled: true },
  retrying: { rank: 1, settled: false },
  running: { rank: 2, settled: false },
  rate_limited: { rank: 3, settled: false },
  waiting: { rank: 4, settled: false },
  sleeping: { rank: 5, settled: false },
  queued: { rank: 6, settled: false },
  cancelled: { rank: 7, settled: true },
  succeeded: { rank: 8, settled: true },
  skipped: { rank: 9, settled: true },
} as const satisfies Record<NodeRunStatus, { rank: number; settled: boolean }>;

function isNodeRunStatus(value: string): value is NodeRunStatus {
  return Object.hasOwn(NODE_STATUS, value);
}

export function isSettled(status: NodeRunStatus): boolean {
  return NODE_STATUS[status].settled;
}

/** Work that has started and not settled: running, retrying, or held for a person or a clock. */
export function isInFlight(status: NodeRunStatus): boolean {
  return !NODE_STATUS[status].settled;
}

export function byUrgency(a: NodeRunStatus, b: NodeRunStatus): number {
  return NODE_STATUS[a].rank - NODE_STATUS[b].rank;
}

/** Statuses with a count, most urgent first. */
export function countedStatuses(
  counts: Partial<Record<NodeRunStatus, number>>,
): { status: NodeRunStatus; count: number }[] {
  return Object.entries(counts)
    .flatMap(([status, count]) =>
      count !== undefined && count > 0 && isNodeRunStatus(status) ? [{ status, count }] : [],
    )
    .sort((a, b) => byUrgency(a.status, b.status));
}
