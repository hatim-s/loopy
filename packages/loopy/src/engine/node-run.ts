import {
  type ExecutionError,
  type Json,
  limitLogs,
  type Node,
  type NodeRun,
  type RunOutcome,
  sameExecution,
} from "../core/index.js";
import { outputLimitError } from "./policy.js";
import { resolveValues } from "./resolve.js";
import { MISSING_INPUT } from "./spec.js";
import { type Changes, nodeRunFor } from "./state.js";

export function write(transition: Changes, nodeRun: NodeRun) {
  const index = transition.state.nodeRuns.findIndex((run) => sameExecution(run.key, nodeRun.key));

  if (index < 0) {
    transition.state.nodeRuns.push(nodeRun);
  } else {
    transition.state.nodeRuns[index] = nodeRun;
  }

  transition.writes.push({ kind: "write_node_run", nodeRun });
}

export function finish(transition: Changes, outcome: RunOutcome, at: string) {
  transition.state.phase = { kind: "finished", outcome };
  transition.writes.push({ kind: "finish_run", outcome, at });

  return { kind: "finished" as const, outcome };
}

export function failNode(transition: Changes, node: Node, error: ExecutionError, at: string) {
  const previous = nodeRunFor(transition.state, node.id);

  write(transition, {
    key: { runId: transition.state.runId, nodeId: node.id, scope: [] },
    attempt: previous?.attempt ?? 1,
    maxAttempts:
      previous?.maxAttempts ??
      (node.kind === "code" || node.kind === "command" ? node.retry.attempts : 1),
    startedAt: previous?.startedAt ?? at,
    endedAt: at,
    status: "failed",
    error,
    receipt: previous?.receipt ?? "none",
  });

  return finish(transition, { status: "failed", error: error.message }, at);
}

export function immediate(transition: Changes, node: Node, output: Json, at: string) {
  const error = outputLimitError(output);

  if (error) {
    return failNode(transition, node, error, at);
  }

  const values =
    node.kind === "log"
      ? resolveValues({ message: node.message, data: node.data }, transition.state)
      : {};

  if (values === undefined) {
    return failNode(transition, node, MISSING_INPUT, at);
  }

  const [log] =
    node.kind === "log"
      ? limitLogs([{ message: String(values.message), data: values.data ?? null }])
      : [];

  const key = { runId: transition.state.runId, nodeId: node.id, scope: [] };
  write(transition, {
    key,
    attempt: 1,
    maxAttempts: 1,
    status: "succeeded",
    startedAt: at,
    endedAt: at,
    output,
    receipt: "none",
  });

  if (log) {
    transition.writes.push({ kind: "write_log", executionKey: key, attempt: 1, log, at });
  }
}
