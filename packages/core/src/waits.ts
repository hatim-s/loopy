import type { NodeRun } from "./graph/node-run";
import { isTerminalRun, type RunRecord, type WaitRecord } from "./model";

/**
 * A wait accepts a signal while its run is live, its node still waits and its deadline is ahead.
 * A timed-out wait stays unexpired until the reducer next runs, so the deadline decides here.
 * The store's pending-hook SQL mirrors this rule.
 */
export function isPendingWait({
  wait,
  node,
  run,
  at,
}: {
  wait: WaitRecord;
  node: NodeRun | undefined;
  run: Pick<RunRecord, "status">;
  at: string;
}): boolean {
  return (
    !isTerminalRun(run.status) &&
    wait.resolvedAt === undefined &&
    wait.expiredAt === undefined &&
    node?.status === "waiting" &&
    (node.wakeAt === null || Date.parse(at) < Date.parse(node.wakeAt))
  );
}
