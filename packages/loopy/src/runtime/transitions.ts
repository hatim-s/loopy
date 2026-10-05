import type { AttemptRecord, Json, ResolvedCommand, WorkflowNode } from "../core/model.js";
import { validateRunInput } from "./preflight.js";
import { type Outputs, resolveCommand, resolveValue } from "./values.js";

export type RuntimeDecision =
  | { kind: "skip" }
  | { kind: "command"; nodeId: string; command: ResolvedCommand }
  | { kind: "condition"; nodeId: string; branch: "then" | "else"; test?: boolean }
  | { kind: "blocked"; status: "failed" | "interrupted"; error: string };

/** One graph decision, shared by process and durable drivers. No storage or executor calls. */
export function decideNode(
  node: WorkflowNode,
  input: Json,
  outputs: Outputs,
  previous: AttemptRecord | undefined,
  options: { resume: boolean; retryUncertain: boolean },
): RuntimeDecision {
  if (previous?.status === "failed" && !options.resume)
    return { kind: "blocked", status: "failed", error: previous.error ?? `Node ${node.id} failed` };
  if (previous?.status === "uncertain" && !options.retryUncertain)
    return {
      kind: "blocked",
      status: "interrupted",
      error: `Node ${node.id} may have changed external state. Resume with retryUncertain to run it again.`,
    };
  if (node.kind === "command")
    return previous?.status === "succeeded"
      ? { kind: "skip" }
      : { kind: "command", nodeId: node.id, command: resolveCommand(node, input, outputs) };
  if (previous?.status === "succeeded") {
    const branch = (previous.output as { branch?: unknown } | undefined)?.branch;
    if (branch !== "then" && branch !== "else")
      return {
        kind: "blocked",
        status: "failed",
        error: `Condition ${node.id} has no recorded branch`,
      };
    return { kind: "condition", nodeId: node.id, branch };
  }
  const test = resolveValue(node.test, input, outputs);
  if (typeof test !== "boolean") throw new Error(`Condition ${node.id} must resolve to boolean`);
  return { kind: "condition", nodeId: node.id, branch: test ? "then" : "else", test };
}

export type NextDecision =
  | Exclude<RuntimeDecision, { kind: "skip" }>
  | { kind: "done" }
  | { kind: "reconcile"; attempt: AttemptRecord };

/** Reconstructs the next graph action from persisted checkpoints. Running attempts
 * must reconcile their stable key before any launch. Preflight checks remaining work.
 */
export function decideNext(
  workflow: { nodes: readonly WorkflowNode[] },
  input: Json,
  attempts: readonly AttemptRecord[],
  options: { resume: boolean; retryUncertain: boolean },
): NextDecision {
  const latest = new Map<string, AttemptRecord>();
  for (const attempt of attempts) {
    const prior = latest.get(attempt.nodeId);
    if (!prior || prior.number < attempt.number) latest.set(attempt.nodeId, attempt);
  }
  const outputs: Outputs = new Map();
  for (const attempt of latest.values())
    if (attempt.status === "succeeded" && attempt.output !== undefined)
      outputs.set(attempt.nodeId, attempt.output);
  function walk(nodes: readonly WorkflowNode[]): NextDecision {
    for (const [index, node] of nodes.entries()) {
      validateRunInput(nodes.slice(index), input, outputs);
      const previous = latest.get(node.id);
      if (previous?.status === "running") return { kind: "reconcile", attempt: previous };
      const decision = decideNode(node, input, outputs, previous, options);
      if (decision.kind === "skip") continue;
      if (decision.kind !== "condition" || decision.test !== undefined) return decision;
      if (node.kind === "condition") {
        const branch = walk(node[decision.branch]);
        if (branch.kind !== "done") return branch;
      }
    }
    return { kind: "done" };
  }
  return walk(workflow.nodes);
}
