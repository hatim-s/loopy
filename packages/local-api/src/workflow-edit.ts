import {
  type JsonValue,
  type WorkflowDefinition,
  WorkflowDefinitionSchema,
  type WorkflowPatch,
  type WorkflowPatchDiagnostic,
  type WorkflowPatchOperation,
  WorkflowPatchSchema,
  type WorkflowVersionDiff,
} from "@loopy/contracts";
import { compileWorkflow } from "@loopy/runtime";

export class WorkflowEditError extends Error {
  constructor(
    readonly diagnostic: WorkflowPatchDiagnostic,
    readonly status = 400,
  ) {
    super(diagnostic.message);
    this.name = "WorkflowEditError";
  }
}

function diagnostic(
  code: string,
  message: string,
  path: string,
  operationIndex?: number,
  extras: Pick<WorkflowPatchDiagnostic, "nodeId" | "edgeId"> = {},
): WorkflowPatchDiagnostic {
  return {
    code,
    severity: "error",
    message,
    path: path.startsWith("/") ? path : `/${path}`,
    ...(operationIndex === undefined ? {} : { operationIndex }),
    ...extras,
  };
}

function fail(
  code: string,
  message: string,
  path: string,
  operationIndex?: number,
  extras: Pick<WorkflowPatchDiagnostic, "nodeId" | "edgeId"> = {},
): never {
  throw new WorkflowEditError(diagnostic(code, message, path, operationIndex, extras));
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function nodeIndex(workflow: WorkflowDefinition, id: string, index: number): number {
  const found = workflow.nodes.findIndex((node) => node.id === id);
  if (found < 0)
    fail("NODE_NOT_FOUND", `Node '${id}' was not found.`, "/nodes", index, { nodeId: id });
  return found;
}

function edgeIndex(workflow: WorkflowDefinition, id: string, index: number): number {
  const found = workflow.edges.findIndex((edge) => edge.id === id);
  if (found < 0)
    fail("EDGE_NOT_FOUND", `Edge '${id}' was not found.`, "/edges", index, { edgeId: id });
  return found;
}

function nodeAt(workflow: WorkflowDefinition, index: number): WorkflowDefinition["nodes"][number] {
  const node = workflow.nodes[index];
  if (!node) throw new Error("Workflow node disappeared while applying patch");
  return node;
}

function edgeAt(workflow: WorkflowDefinition, index: number): WorkflowDefinition["edges"][number] {
  const edge = workflow.edges[index];
  if (!edge) throw new Error("Workflow edge disappeared while applying patch");
  return edge;
}

function applyOperation(
  workflow: WorkflowDefinition,
  operation: WorkflowPatchOperation,
  index: number,
): void {
  switch (operation.op) {
    case "add_node":
      if (workflow.nodes.some((node) => node.id === operation.node.id))
        fail("DUPLICATE_NODE_ID", `Node '${operation.node.id}' already exists.`, `/nodes`, index, {
          nodeId: operation.node.id,
        });
      workflow.nodes.push(clone(operation.node));
      return;
    case "remove_node": {
      const found = nodeIndex(workflow, operation.nodeId, index);
      workflow.nodes.splice(found, 1);
      // Removing a node removes its incident edges as one bounded graph edit.
      workflow.edges = workflow.edges.filter(
        (edge) => edge.source !== operation.nodeId && edge.target !== operation.nodeId,
      );
      return;
    }
    case "replace_node": {
      const found = nodeIndex(workflow, operation.node.id, index);
      workflow.nodes[found] = clone(operation.node);
      return;
    }
    case "add_edge":
      if (workflow.edges.some((edge) => edge.id === operation.edge.id))
        fail("DUPLICATE_EDGE_ID", `Edge '${operation.edge.id}' already exists.`, `/edges`, index, {
          edgeId: operation.edge.id,
        });
      workflow.edges.push(clone(operation.edge));
      return;
    case "remove_edge":
      workflow.edges.splice(edgeIndex(workflow, operation.edgeId, index), 1);
      return;
    case "set_workflow_name":
      workflow.name = operation.name;
      return;
    case "set_workflow_description":
      if (operation.description === null) delete workflow.description;
      else workflow.description = operation.description;
      return;
    case "set_provider_defaults":
      workflow.defaults = clone(operation.defaults);
      return;
    case "set_policy":
      workflow.policies = clone(operation.policies);
      return;
    case "set_input": {
      const found = workflow.inputs.findIndex((input) => input.name === operation.input.name);
      if (found >= 0) workflow.inputs[found] = clone(operation.input);
      else workflow.inputs.push(clone(operation.input));
      return;
    }
    case "remove_input": {
      const found = workflow.inputs.findIndex((input) => input.name === operation.name);
      if (found < 0)
        fail("INPUT_NOT_FOUND", `Input '${operation.name}' was not found.`, "/inputs", index);
      workflow.inputs.splice(found, 1);
      return;
    }
    case "set_node_prompt": {
      const found = nodeIndex(workflow, operation.nodeId, index);
      const node = nodeAt(workflow, found);
      if (node.kind !== "agent")
        fail(
          "NODE_KIND_MISMATCH",
          "Prompt edits require an agent node.",
          `/nodes/${found}`,
          index,
          { nodeId: operation.nodeId },
        );
      node.prompt = operation.prompt;
      return;
    }
    case "set_node_provider": {
      const found = nodeIndex(workflow, operation.nodeId, index);
      const node = nodeAt(workflow, found);
      if (node.kind !== "agent")
        fail(
          "NODE_KIND_MISMATCH",
          "Provider edits require an agent node.",
          `/nodes/${found}`,
          index,
          { nodeId: operation.nodeId },
        );
      if (operation.provider === null) delete node.provider;
      else node.provider = operation.provider;
      return;
    }
    case "set_node_model": {
      const found = nodeIndex(workflow, operation.nodeId, index);
      const node = nodeAt(workflow, found);
      if (node.kind !== "agent")
        fail("NODE_KIND_MISMATCH", "Model edits require an agent node.", `/nodes/${found}`, index, {
          nodeId: operation.nodeId,
        });
      if (operation.model === null) delete node.model;
      else node.model = operation.model;
      return;
    }
    case "set_node_reasoning": {
      const found = nodeIndex(workflow, operation.nodeId, index);
      const node = nodeAt(workflow, found);
      if (node.kind !== "agent")
        fail(
          "NODE_KIND_MISMATCH",
          "Reasoning edits require an agent node.",
          `/nodes/${found}`,
          index,
          { nodeId: operation.nodeId },
        );
      if (operation.reasoning === null) delete node.reasoning;
      else node.reasoning = operation.reasoning;
      return;
    }
    case "set_verification": {
      const found = nodeIndex(workflow, operation.nodeId, index);
      const node = nodeAt(workflow, found);
      if (node.kind !== "verify")
        fail(
          "NODE_KIND_MISMATCH",
          "Verification edits require a verify node.",
          `/nodes/${found}`,
          index,
          { nodeId: operation.nodeId },
        );
      node.commands = clone(operation.commands);
      node.success = operation.success;
      node.expectedExitCode = operation.expectedExitCode;
      return;
    }
    case "set_route": {
      const found = nodeIndex(workflow, operation.nodeId, index);
      const node = nodeAt(workflow, found);
      if (node.kind !== "route")
        fail("NODE_KIND_MISMATCH", "Route edits require a route node.", `/nodes/${found}`, index, {
          nodeId: operation.nodeId,
        });
      node.predicate = clone(operation.predicate);
      if (operation.defaultRoute === undefined || operation.defaultRoute === null)
        delete node.defaultRoute;
      else node.defaultRoute = operation.defaultRoute;
      return;
    }
    case "set_join": {
      const found = nodeIndex(workflow, operation.nodeId, index);
      const node = nodeAt(workflow, found);
      if (node.kind !== "join")
        fail("NODE_KIND_MISMATCH", "Join edits require a join node.", `/nodes/${found}`, index, {
          nodeId: operation.nodeId,
        });
      node.policy = operation.policy;
      node.outputMode = operation.outputMode;
      if (operation.quorum === undefined || operation.quorum === null) delete node.quorum;
      else node.quorum = operation.quorum;
      return;
    }
    case "set_edge_label": {
      const found = edgeIndex(workflow, operation.edgeId, index);
      edgeAt(workflow, found).label = operation.label;
      return;
    }
    case "set_edge_condition": {
      const found = edgeIndex(workflow, operation.edgeId, index);
      edgeAt(workflow, found).condition = clone(operation.condition);
      return;
    }
    case "set_route_default": {
      const found = nodeIndex(workflow, operation.nodeId, index);
      const node = nodeAt(workflow, found);
      if (node.kind !== "route")
        fail("NODE_KIND_MISMATCH", "Route edits require a route node.", `/nodes/${found}`, index, {
          nodeId: operation.nodeId,
        });
      node.defaultRoute = operation.defaultRoute;
      return;
    }
  }
}

export function applyWorkflowPatch(
  input: WorkflowDefinition,
  patch: WorkflowPatch,
): WorkflowDefinition {
  const parsed = WorkflowPatchSchema.safeParse(patch);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    fail(
      "PATCH_CONTRACT_INVALID",
      issue?.message ?? "Patch is invalid.",
      `/${issue?.path.join("/") ?? "patch"}`,
    );
  }
  const normalized = parsed.data;
  if (normalized.workflowId !== input.id)
    fail(
      "WORKFLOW_ID_MISMATCH",
      "Patch workflowId does not match the base workflow.",
      "/workflowId",
    );
  if (normalized.baseVersion !== input.workflowVersion)
    fail(
      "WORKFLOW_VERSION_MISMATCH",
      "Patch baseVersion does not match the base workflow version.",
      "/baseVersion",
    );
  const next = clone(input);
  const operations = "operations" in normalized ? normalized.operations : normalized.patch;
  for (const [index, operation] of operations.entries()) applyOperation(next, operation, index);
  return next;
}

export function validateWorkflowForSave(input: unknown): {
  workflow?: WorkflowDefinition;
  diagnostics: WorkflowPatchDiagnostic[];
} {
  const parsed = WorkflowDefinitionSchema.safeParse(input);
  const diagnostics: WorkflowPatchDiagnostic[] = parsed.success
    ? []
    : parsed.error.issues.map((issue) => ({
        code: "WORKFLOW_CONTRACT_INVALID",
        severity: "error" as const,
        message: issue.message,
        path: `/${issue.path.join("/")}`,
      }));
  const workflow = parsed.success ? parsed.data : undefined;
  if (workflow) {
    const compiled = compileWorkflow(workflow);
    for (const item of compiled.diagnostics) {
      diagnostics.push({
        code: item.code,
        severity: item.severity,
        message: item.message,
        path: item.path,
        ...(item.nodeId ? { nodeId: item.nodeId } : {}),
        ...(item.edgeId ? { edgeId: item.edgeId } : {}),
      });
    }
  }
  return { ...(workflow ? { workflow } : {}), diagnostics };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function pointerSegment(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

type KeyedArrayPath = "/nodes" | "/edges" | "/inputs";

function keyedArrayKey(path: string, value: unknown): string | undefined {
  if (!isObject(value)) return undefined;
  const key = path as KeyedArrayPath;
  if (key === "/nodes" || key === "/edges")
    return typeof value.id === "string" ? value.id : undefined;
  if (key === "/inputs") return typeof value.name === "string" ? value.name : undefined;
  return undefined;
}

function diffKeyedArray(
  before: unknown[],
  after: unknown[],
  path: KeyedArrayPath,
  changes: WorkflowVersionDiff["changes"],
): boolean {
  const beforeKeys = before.map((value) => keyedArrayKey(path, value));
  const afterKeys = after.map((value) => keyedArrayKey(path, value));
  const keys = [...beforeKeys, ...afterKeys];
  // A malformed legacy definition may contain duplicate or missing semantic
  // keys. Preserve the ordinary index diff for that data instead of silently
  // dropping one of the duplicate entries from a map.
  const hasDuplicateOrMissingKey = (values: Array<string | undefined>) =>
    values.some((key) => key === undefined) || new Set(values).size !== values.length;
  if (hasDuplicateOrMissingKey(beforeKeys) || hasDuplicateOrMissingKey(afterKeys)) return false;
  const beforeByKey = new Map(beforeKeys.map((key, index) => [key as string, before[index]]));
  const afterByKey = new Map(afterKeys.map((key, index) => [key as string, after[index]]));
  const semanticKeys = [...new Set(keys)].filter((key): key is string => key !== undefined).sort();
  for (const key of semanticKeys)
    diffValues(
      beforeByKey.get(key),
      afterByKey.get(key),
      `${path}/${pointerSegment(key)}`,
      changes,
    );
  return true;
}

function diffValues(
  before: unknown,
  after: unknown,
  path: string,
  changes: WorkflowVersionDiff["changes"],
): void {
  if (Object.is(before, after)) return;
  if (isObject(before) && isObject(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    for (const key of keys)
      diffValues(before[key], after[key], `${path}/${pointerSegment(key)}`, changes);
    return;
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    if (
      (path === "/nodes" || path === "/edges" || path === "/inputs") &&
      diffKeyedArray(before, after, path, changes)
    )
      return;
    const length = Math.max(before.length, after.length);
    for (let index = 0; index < length; index += 1)
      diffValues(before[index], after[index], `${path}/${index}`, changes);
    return;
  }
  changes.push({
    path: path || "/",
    ...(before === undefined ? {} : { before: before as JsonValue }),
    ...(after === undefined ? {} : { after: after as JsonValue }),
  });
}

export function workflowVersionDiff(
  workflowId: string,
  fromVersion: number,
  toVersion: number,
  before: WorkflowDefinition,
  after: WorkflowDefinition,
): WorkflowVersionDiff {
  const changes: WorkflowVersionDiff["changes"] = [];
  diffValues(before, after, "", changes);
  return {
    schemaVersion: "1",
    workflowId,
    fromVersion,
    toVersion,
    changed: changes.length > 0,
    changes,
  };
}
