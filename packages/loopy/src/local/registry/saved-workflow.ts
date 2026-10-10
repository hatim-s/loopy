import type { SecretBindings, Workflow, WorkflowNode } from "../../core/index.js";
import { isRecord, isString } from "../../core/index.js";

export type SavedWorkflow = {
  workflow: Workflow;
  source: string;
  updatedAt: string;
  secretBindings?: SecretBindings;
};

export type SaveOptions = { replace?: boolean };

/** The on-disk shape before the workflow and bindings have been validated. */
export type SavedFile = {
  workflow: unknown;
  source: string;
  updatedAt: string;
  secretBindings?: unknown;
};

export function isSavedFile(value: unknown): value is SavedFile {
  return (
    isRecord(value) && "workflow" in value && isString(value.source) && isString(value.updatedAt)
  );
}

export function countNodes(nodes: WorkflowNode[]): number {
  return nodes.reduce(
    (count, node) =>
      count + 1 + (node.kind === "condition" ? countNodes(node.then) + countNodes(node.else) : 0),
    0,
  );
}
