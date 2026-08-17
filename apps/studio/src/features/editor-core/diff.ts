import type { WorkflowDefinition, WorkflowEdge, WorkflowNode } from "@loopy/contracts";

export type WorkflowDiff = {
  workflowChanged: boolean;
  changedWorkflowFields: Array<
    "name" | "description" | "inputs" | "defaults" | "policies" | "triggers" | "metadata"
  >;
  addedNodes: WorkflowNode[];
  removedNodes: WorkflowNode[];
  changedNodes: Array<{ before: WorkflowNode; after: WorkflowNode }>;
  addedEdges: WorkflowEdge[];
  removedEdges: WorkflowEdge[];
  changedEdges: Array<{ before: WorkflowEdge; after: WorkflowEdge }>;
};

function equalJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function diffWorkflowVersions(
  before: WorkflowDefinition,
  after: WorkflowDefinition,
): WorkflowDiff {
  const beforeNodes = new Map(before.nodes.map((node) => [node.id, node]));
  const afterNodes = new Map(after.nodes.map((node) => [node.id, node]));
  const beforeEdges = new Map(before.edges.map((edge) => [edge.id, edge]));
  const afterEdges = new Map(after.edges.map((edge) => [edge.id, edge]));
  const addedNodes = after.nodes.filter((node) => !beforeNodes.has(node.id));
  const removedNodes = before.nodes.filter((node) => !afterNodes.has(node.id));
  const changedNodes = after.nodes.flatMap((node) => {
    const previous = beforeNodes.get(node.id);
    return previous && !equalJson(previous, node) ? [{ before: previous, after: node }] : [];
  });
  const addedEdges = after.edges.filter((edge) => !beforeEdges.has(edge.id));
  const removedEdges = before.edges.filter((edge) => !afterEdges.has(edge.id));
  const changedEdges = after.edges.flatMap((edge) => {
    const previous = beforeEdges.get(edge.id);
    return previous && !equalJson(previous, edge) ? [{ before: previous, after: edge }] : [];
  });
  const changedWorkflowFields = (
    ["name", "description", "inputs", "defaults", "policies", "triggers", "metadata"] as const
  ).filter((field) => {
    const beforeValue = before[field];
    const afterValue = after[field];
    return !equalJson(beforeValue, afterValue);
  });
  return {
    workflowChanged: changedWorkflowFields.length > 0,
    changedWorkflowFields: [...changedWorkflowFields],
    addedNodes,
    removedNodes,
    changedNodes,
    addedEdges,
    removedEdges,
    changedEdges,
  };
}
