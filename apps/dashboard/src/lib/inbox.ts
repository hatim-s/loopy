import type { RunView } from "loopy/contract";
import type { RunsQuery } from "../backend/backend.ts";

/**
 * The contract has no waiting filter, so the inbox fetches suspended runs and keeps the ones
 * with waitingOn set. 200 is the server's page cap.
 */
export const INBOX_QUERY = { status: "suspended", limit: 200 } as const satisfies RunsQuery;

export type WaitingRun = RunView & { waitingOn: NonNullable<RunView["waitingOn"]> };

export type InboxGroup = { slug: string; runs: WaitingRun[] };

function isWaiting(run: RunView): run is WaitingRun {
  return run.waitingOn !== null;
}

/** A suspended run stops changing once it waits, so updatedAt is when the wait began. */
export function waitingSince(run: WaitingRun): string {
  return run.updatedAt;
}

/** Waiting runs grouped by loopy, oldest wait first within a group and across groups. */
export function inboxGroups(runs: RunView[]): InboxGroup[] {
  const groups = new Map<string, WaitingRun[]>();

  const waiting = runs
    .filter(isWaiting)
    .sort((a, b) => waitingSince(a).localeCompare(waitingSince(b)) || a.id.localeCompare(b.id));

  for (const run of waiting) {
    groups.set(run.loopy.slug, [...(groups.get(run.loopy.slug) ?? []), run]);
  }

  return [...groups].map(([slug, items]) => ({ slug, runs: items }));
}

export function waitingCount(groups: InboxGroup[]): number {
  return groups.reduce((total, group) => total + group.runs.length, 0);
}
