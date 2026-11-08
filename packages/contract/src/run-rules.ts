import { isTerminalRun, type NodeRun } from "@loopy/core";
import type { RunsQuery } from "./api";
import type { RunView } from "./views";

/** The store wakes a run only when no live owner holds it, and never reopens a finished run. */
export function canResumeRun(run: Pick<RunView, "status" | "owner" | "ownerStale">): boolean {
  return !isTerminalRun(run.status) && (run.owner === null || run.ownerStale);
}

/** Cancellation claims the run first, so it needs the same free or lapsed ownership as resume. */
export const canCancelRun = canResumeRun;

/** Why cancellation must wait for a running execution, or null when none runs. */
export function runningRefusal(nodes: readonly Pick<NodeRun, "status">[]): string | null {
  return nodes.some((node) => node.status === "running")
    ? "This run has an unfinished execution. Resume it before cancelling."
    : null;
}

/** Why a started run with finally nodes cannot be cancelled, or null when it can. */
export function cleanupRefusal(
  nodes: readonly unknown[],
  graph: { readonly nodes: readonly { readonly kind: string }[] },
): string | null {
  // Finally cleanup on cancel needs a host that sends cancel_requested, and no host does yet.
  return nodes.length > 0 && graph.nodes.some((node) => node.kind === "finally")
    ? "This run requires finally cleanup. Cancellation with cleanup is not available; resume the run instead."
    : null;
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
