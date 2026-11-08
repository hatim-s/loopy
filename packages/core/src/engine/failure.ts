import type { ExecutionError } from "../executor";
import { isExecutable } from "../graph/nodes";
import { type OutSchemaIssue, outSchemaMessage } from "../record-spec";
import { type Execution, runBase, type Transition, write } from "./node-run";

export function outputError(issue: OutSchemaIssue): ExecutionError {
  return {
    code: issue === "output_limit" ? "output_limit" : "validation",
    message: outSchemaMessage("Node output", issue),
  };
}

export function failNode(
  transition: Transition,
  execution: Execution,
  options: { error: ExecutionError; at: string },
) {
  const { node } = execution;
  const declared = isExecutable(node) ? node.retry.attempts : 1;

  write(transition, {
    ...runBase(execution, options.at, declared),
    endedAt: options.at,
    status: "failed",
    error: options.error,
  });
}
