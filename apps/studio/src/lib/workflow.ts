import type { AttemptRecord, Json, WorkflowNode } from "loopy";
import { isRecord } from "loopy";

/** Renders a persisted value the way an author would write it. */
export function describe(value: unknown): string {
  if (!isRecord(value)) {
    return typeof value === "string" ? value : JSON.stringify(value);
  }
  const { $ref, $op, args } = value;
  if (isRecord($ref) && Array.isArray($ref.path)) {
    return `${String($ref.source)}.${$ref.path.map(String).join(".")}`;
  }
  if (typeof $op === "string" && Array.isArray(args)) {
    return `${$op}(${args.map(describe).join(", ")})`;
  }
  return JSON.stringify(value);
}

/** Depth-first lookup that also searches condition branches. */
export function findNode(nodes: WorkflowNode[], id: string): WorkflowNode | undefined {
  for (const node of nodes) {
    if (node.id === id) {
      return node;
    }
    if (node.kind === "condition") {
      const child = findNode(node.then, id) ?? findNode(node.else, id);
      if (child) {
        return child;
      }
    }
  }
}

/** Which arm a succeeded condition attempt took, if its output says. */
export function selectedBranch(attempt?: AttemptRecord): "then" | "else" | undefined {
  if (attempt?.status !== "succeeded" || !isRecord(attempt.output)) {
    return;
  }
  const branch = attempt.output.branch;
  return branch === "then" || branch === "else" ? branch : undefined;
}

export function outputText(output: Json | undefined, key: "stdout" | "stderr"): string | undefined {
  if (!isRecord(output)) {
    return;
  }
  const value = output[key];
  return typeof value === "string" ? value : undefined;
}
