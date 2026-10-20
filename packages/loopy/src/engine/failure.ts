import type { ExecutionError, ExecutionKey, Node } from "../core/index.js";
import { type Transition, write } from "./node-run.js";
import { sameExecution } from "./resolve.js";

export function failNode(
  transition: Transition,
  node: Node,
  options: { error: ExecutionError; at: string; scope: ExecutionKey["scope"] },
) {
  const { error, at, scope } = options;
  const key = { runId: transition.state.runId, nodeId: node.id, scope };
  const previous = transition.state.nodeRuns.find((run) => sameExecution(run.key, key));
  write(transition, {
    key,
    attempt: previous?.attempt ?? 1,
    maxAttempts: previous?.maxAttempts ?? ("retry" in node ? node.retry.attempts : 1),
    startedAt: previous?.startedAt ?? at,
    endedAt: at,
    status: "failed",
    error,
    receipt: previous?.receipt ?? "none",
  });
}
