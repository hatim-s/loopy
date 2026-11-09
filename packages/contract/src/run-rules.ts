import { isTerminalRun, type NodeRun } from "@loopy/core";
import type { RunsQuery } from "./api";
import type { RunView } from "./views";

/** The store wakes a run only when no live owner holds it, and never reopens a finished run. */
export function canResumeRun(run: Pick<RunView, "status" | "owner" | "ownerStale">): boolean {
  return !isTerminalRun(run.status) && (run.owner === null || run.ownerStale);
}

/** Cancellation claims the run first, so it needs the same free or lapsed ownership as resume. */
export const canCancelRun = canResumeRun;

/** Why the service refuses to cancel a run with these node runs, or null when it may. */
export function cancelRefusal(
  nodes: readonly Pick<NodeRun, "status">[],
  graph: { readonly nodes: readonly { readonly kind: string }[] },
): string | null {
  if (nodes.some((node) => node.status === "running")) {
    return "This run has an unfinished execution. Resume it before cancelling.";
  }

  // Cleanup needs host cancellation, which PR 4c owns.
  if (nodes.length > 0 && graph.nodes.some((node) => node.kind === "finally")) {
    return "This run requires finally cleanup. Cancellation with cleanup is not available; resume the run instead.";
  }

  return null;
}

/** The client-side form of the store's run list filter, for patching cached lists from events. */
export function runMatchesQuery(query: RunsQuery, run: RunView): boolean {
  const waiting = query.waiting === undefined ? undefined : String(query.waiting) === "true";

  return (
    (query.slug === undefined || query.slug === run.slug) &&
    (query.status === undefined || query.status === run.status) &&
    (query.workspace === undefined || query.workspace === run.workspace) &&
    (query.from === undefined || run.createdAt >= query.from) &&
    (query.to === undefined || run.createdAt < query.to) &&
    (waiting === undefined || waiting === (run.waitingOn !== null))
  );
}
