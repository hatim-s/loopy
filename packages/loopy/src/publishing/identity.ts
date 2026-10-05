import type { Workflow } from "../core/model.js";
import { hashContent, type PublishBundle } from "./manifest.js";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, child]) => [key, canonical(child)]),
    );
  return value;
}
export function compilationBytes(
  bundle: PublishBundle,
  workflow: Workflow,
  graphHash: string,
  imageDigest: string,
): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify(canonical({ bundle, workflow, graphHash, imageDigest })),
  );
}
export function workflowGraphHash(workflow: Workflow): Promise<string> {
  return hashContent(new TextEncoder().encode(JSON.stringify(canonical(workflow))));
}

export function canonicalWorkflow(workflow: Workflow): Workflow {
  return canonical(workflow) as Workflow;
}
