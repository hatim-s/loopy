import type { ExecutionError, Node } from "../core/index.js";
import { finish, type Transition, write } from "./node-run.js";

export function failNode(transition: Transition, node: Node, error: ExecutionError, at: string) {
  const previous = transition.state.nodeRuns.find(
    (run) => run.key.nodeId === node.id && run.key.scope.length === 0,
  );

  write(transition, {
    key: { runId: transition.state.runId, nodeId: node.id, scope: [] },
    attempt: previous?.attempt ?? 1,
    maxAttempts: previous?.maxAttempts ?? ("retry" in node ? node.retry.attempts : 1),
    startedAt: previous?.startedAt ?? at,
    endedAt: at,
    status: "failed",
    error,
    receipt: previous?.receipt ?? "none",
  });
  finish(transition, { status: "failed", error: error.message }, at);
}
