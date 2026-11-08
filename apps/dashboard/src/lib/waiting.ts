import type { RunView } from "@loopy/contract";
import { useRunPages } from "./pages";

export type WaitingRun = RunView & { waitingOn: NonNullable<RunView["waitingOn"]> };

export function isWaiting(run: RunView): run is WaitingRun {
  return run.waitingOn !== null;
}

// The awaiting count reads one page; past it the count says "20+" rather than guess.
const AWAITING_PAGE = 20;

export function useAwaitingRuns() {
  return useRunPages({ status: "suspended", waiting: true }, AWAITING_PAGE);
}

export function pageCount(page: { rows: unknown[]; hasNext: boolean }): string {
  return `${page.rows.length}${page.hasNext ? "+" : ""}`;
}
