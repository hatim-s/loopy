import { queryOptions } from "@tanstack/react-query";
import type { LoopyView, RunStatus, RunView } from "loopy/contract";
import type { LoopyBackend } from "../backend/backend.ts";
import { keys } from "./keys.ts";

type Counts = LoopyView["counts"];

/** Run counts summed over every saved loopy, straight from the loopy views. */
export function totalCounts(loopies: LoopyView[]): Counts {
  const sum = (status: RunStatus) =>
    loopies.reduce((total, loopy) => total + loopy.counts[status], 0);

  return {
    queued: sum("queued"),
    running: sum("running"),
    suspended: sum("suspended"),
    succeeded: sum("succeeded"),
    failed: sum("failed"),
    cancelled: sum("cancelled"),
  };
}

export const LOOPY_SORTS = ["attention", "name", "recent", "next"] as const;

export type LoopySort = (typeof LOOPY_SORTS)[number];

// Lower ranks need a person sooner: a failure, then work in flight, then everything else.
const RANK = {
  failed: 0,
  suspended: 1,
  running: 2,
  queued: 2,
  cancelled: 3,
  succeeded: 4,
} satisfies Record<RunStatus, number>;

function lastRunAt(loopy: LoopyView): string {
  return loopy.lastRun?.createdAt ?? "";
}

function nextFireAt(loopy: LoopyView): string | null {
  const schedule = loopy.schedule;

  return schedule?.enabled ? schedule.nextFireAt : null;
}

const COMPARE = {
  attention: (a, b) =>
    (a.lastRun ? RANK[a.lastRun.status] : 5) - (b.lastRun ? RANK[b.lastRun.status] : 5) ||
    lastRunAt(b).localeCompare(lastRunAt(a)),
  name: (a, b) => a.slug.localeCompare(b.slug),
  recent: (a, b) => lastRunAt(b).localeCompare(lastRunAt(a)),
  next: (a, b) => {
    const left = nextFireAt(a);
    const right = nextFireAt(b);

    if (left === null || right === null) {
      return Number(left === null) - Number(right === null);
    }

    return left.localeCompare(right);
  },
} satisfies Record<LoopySort, (a: LoopyView, b: LoopyView) => number>;

export function sortLoopies(loopies: LoopyView[], sort: LoopySort): LoopyView[] {
  return [...loopies].sort((a, b) => COMPARE[sort](a, b) || a.slug.localeCompare(b.slug));
}

/** The soonest enabled schedule, so the overview can say what fires next. */
export function nextFire(loopies: LoopyView[]): { slug: string; at: string } | null {
  const [first] = sortLoopies(loopies, "next");
  const at = first ? nextFireAt(first) : null;

  return first && at !== null ? { slug: first.slug, at } : null;
}

/** Statuses that still hold or want a worker. Suspended runs wait on a hook or a timer. */
export const ACTIVE_STATUSES = ["running", "queued", "suspended"] as const satisfies RunStatus[];

export type ActiveStatus = (typeof ACTIVE_STATUSES)[number];

/** Rows fetched per active status. A full list means older runs of that status were left out. */
export const ACTIVE_LIMIT = 50;

/** One live list per active status; the event stream keeps each `["runs", query]` entry current. */
export function activeRunsQuery(backend: LoopyBackend, status: ActiveStatus) {
  const query = { status, limit: ACTIVE_LIMIT } as const;

  return queryOptions({ queryKey: keys.runs(query), queryFn: () => backend.runs(query) });
}

/**
 * The per-status lists as one list, running first, oldest first within each status. A run can
 * sit in two lists for a moment when a refetch lands after its next transition, so each id keeps
 * only its most recently updated copy.
 */
export function mergeActiveRuns(lists: RunView[][]): RunView[] {
  const latest = new Map<string, RunView>();

  for (const run of lists.flat()) {
    const kept = latest.get(run.id);

    if (!kept || run.updatedAt > kept.updatedAt) {
      latest.set(run.id, run);
    }
  }

  const rank = (run: RunView) => ACTIVE_STATUSES.findIndex((status) => status === run.status);

  return [...latest.values()].sort(
    (a, b) => rank(a) - rank(b) || a.createdAt.localeCompare(b.createdAt),
  );
}
