import type { LoopyView, RunStatus } from "loopy/contract";
import type { LoopyRow } from "./view-models.ts";

export const LOOPY_FILTERS = ["all", "scheduled", "failing", "active"] as const;

export type LoopyFilter = (typeof LOOPY_FILTERS)[number];

export const LOOPY_SORTS = ["attention", "name", "success", "runs", "next"] as const;

export type LoopySort = (typeof LOOPY_SORTS)[number];

/** Finished runs that succeeded, or null when none finished. In-flight runs do not count. */
export function successRate(counts: LoopyView["counts"]): number | null {
  const finished = counts.succeeded + counts.failed + counts.cancelled;

  return finished === 0 ? null : counts.succeeded / finished;
}

function total(loopy: LoopyRow): number {
  return Object.values(loopy.counts).reduce((sum, count) => sum + count, 0);
}

const MATCH = {
  all: () => true,
  scheduled: (loopy) => loopy.schedule?.enabled === true,
  failing: (loopy) => loopy.lastRun?.status === "failed",
  active: (loopy) => loopy.counts.running + loopy.counts.queued + loopy.counts.suspended > 0,
} satisfies Record<LoopyFilter, (loopy: LoopyRow) => boolean>;

// Lower ranks need a person sooner: a failure, then work held or in flight, then the rest.
const RANK = {
  failed: 0,
  suspended: 1,
  running: 2,
  queued: 2,
  cancelled: 3,
  succeeded: 4,
} satisfies Record<RunStatus, number>;

const NEVER = 5;

function nextFire(loopy: LoopyRow): string | null {
  return loopy.schedule?.enabled ? loopy.schedule.nextFireAt : null;
}

const COMPARE = {
  attention: (a, b) =>
    (a.lastRun ? RANK[a.lastRun.status] : NEVER) - (b.lastRun ? RANK[b.lastRun.status] : NEVER) ||
    (b.lastRun?.createdAt ?? "").localeCompare(a.lastRun?.createdAt ?? ""),
  name: (a, b) => a.slug.localeCompare(b.slug),
  success: (a, b) => (successRate(a.counts) ?? -1) - (successRate(b.counts) ?? -1),
  runs: (a, b) => total(a) - total(b),
  next: (a, b) => {
    const left = nextFire(a);
    const right = nextFire(b);

    // Unscheduled loopies sort last whichever way the column points.
    if (left === null || right === null) {
      return Number(left === null) - Number(right === null);
    }

    return left.localeCompare(right);
  },
} satisfies Record<LoopySort, (a: LoopyRow, b: LoopyRow) => number>;

export type LoopyTableQuery = { q: string; show: LoopyFilter; sort: LoopySort; desc: boolean };

/** Filters, counts per filter for the tabs, and sorted rows. The slug breaks every tie. */
export function loopyTable(loopies: LoopyRow[], query: LoopyTableQuery) {
  const needle = query.q.trim().toLowerCase();

  const matching = loopies.filter(
    (loopy) =>
      needle === "" ||
      loopy.slug.toLowerCase().includes(needle) ||
      (loopy.description ?? "").toLowerCase().includes(needle),
  );

  const counts = { all: 0, scheduled: 0, failing: 0, active: 0 } satisfies Record<
    LoopyFilter,
    number
  >;

  for (const filter of LOOPY_FILTERS) {
    counts[filter] = matching.filter(MATCH[filter]).length;
  }

  const direction = query.desc ? -1 : 1;

  const rows = matching
    .filter(MATCH[query.show])
    .sort((a, b) => direction * COMPARE[query.sort](a, b) || a.slug.localeCompare(b.slug));

  return { rows, counts };
}
