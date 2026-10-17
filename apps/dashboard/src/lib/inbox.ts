import type { RunView } from "loopy/contract";
import type { RunsQuery } from "../backend/backend.ts";

export const INBOX_QUERY = {
  status: "suspended",
  waiting: true,
  limit: 200,
} as const satisfies RunsQuery;

export type WaitingRun = RunView & { waitingOn: NonNullable<RunView["waitingOn"]> };

export type InboxGroup = { slug: string; runs: WaitingRun[] };

function isWaiting(run: RunView): run is WaitingRun {
  return run.status === "suspended" && run.waitingOn !== null;
}

export function waitingSince(run: WaitingRun): string {
  return run.waitingOn.since;
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
