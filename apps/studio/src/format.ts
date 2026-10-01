import type { AttemptRecord, Json, WorkflowNode, Workspace } from "loopy";

/** Renders a persisted value the way an author would write it. */
export function describe(value: unknown): string {
  if (value && typeof value === "object" && "$ref" in value) {
    const ref = value.$ref as { source: string; path: readonly string[] };
    return `${ref.source}.${ref.path.join(".")}`;
  }
  if (value && typeof value === "object" && "$op" in value) {
    const expression = value as { $op: string; args: readonly unknown[] };
    return `${expression.$op}(${expression.args.map(describe).join(", ")})`;
  }
  return typeof value === "string" ? value : JSON.stringify(value);
}

export function formatted(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? String(value);
}

export function shortDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export function shortId(value: string): string {
  return value.length > 12 ? value.slice(0, 8) : value;
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function workspaceName(workspace: Workspace): string {
  return workspace.kind === "local" ? workspace.path : workspace.id;
}

export function latestAttempts(attempts: AttemptRecord[]): Map<string, AttemptRecord> {
  const byNode = new Map<string, AttemptRecord>();
  for (const attempt of attempts) {
    const previous = byNode.get(attempt.nodeId);
    if (
      !previous ||
      attempt.number > previous.number ||
      (attempt.number === previous.number && attempt.startedAt > previous.startedAt)
    )
      byNode.set(attempt.nodeId, attempt);
  }
  return byNode;
}

export function selectedBranch(attempt?: AttemptRecord): "then" | "else" | undefined {
  if (
    attempt?.status !== "succeeded" ||
    !attempt.output ||
    typeof attempt.output !== "object" ||
    Array.isArray(attempt.output)
  )
    return;
  const branch = attempt.output.branch;
  return branch === "then" || branch === "else" ? branch : undefined;
}

export function outputText(output: Json | undefined, key: "stdout" | "stderr"): string | undefined {
  if (!output || typeof output !== "object" || Array.isArray(output)) return;
  const value = output[key];
  return typeof value === "string" ? value : undefined;
}

export function findNode(nodes: WorkflowNode[], id: string): WorkflowNode | undefined {
  for (const node of nodes) {
    if (node.id === id) return node;
    if (node.kind === "condition") {
      const child = findNode(node.then, id) ?? findNode(node.else, id);
      if (child) return child;
    }
  }
}
