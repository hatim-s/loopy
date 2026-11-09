import type { ExecutionError } from "../executor";
import type { ExecutionKey } from "../graph/key";
import type { Node } from "../graph/nodes";
import { type OutSchemaIssue, outSchemaMessage } from "../record-spec";
import { type Transition, write } from "./node-run";
import { sameExecution } from "./resolve";

export function outputError(issue: OutSchemaIssue): ExecutionError {
  return {
    code: issue === "output_limit" ? "output_limit" : "validation",
    message: outSchemaMessage("Node output", issue),
  };
}

export function failNode(
  transition: Transition,
  node: Node,
  options: { error: ExecutionError; at: string; scope: ExecutionKey["scope"] },
) {
  const { error, at, scope } = options;
  const key = { runId: transition.state.runId, nodeId: node.id, scope };
  const previous = transition.state.nodeRuns.find((run) => sameExecution(run.key, key));
  const declared = node.kind === "code" || node.kind === "command" ? node.retry.attempts : 1;

  write(transition, {
    key,
    attempt: previous?.attempt ?? 1,
    maxAttempts: previous?.maxAttempts ?? declared,
    startedAt: previous?.startedAt ?? at,
    endedAt: at,
    status: "failed",
    error,
    receipt: previous?.receipt ?? "none",
  });
}
