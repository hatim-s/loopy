import {
  JoinNodeSchema,
  NodeSchema,
  VerifyCommandSchema,
  type WorkflowDefinition,
  WorkflowDefinitionSchema,
  WorkflowEdgeSchema,
  type WorkflowNode,
} from "@loopy/contracts";
import type {
  CommandResult,
  EditorCommand,
  EditorEdgePatch,
  EditorIdFactory,
  EditorNodePatch,
} from "./types.ts";

function failure(
  reason: Exclude<Extract<CommandResult, { ok: false }>["reason"], never>,
  message: string,
): Extract<CommandResult, { ok: false }> {
  return { ok: false, reason, message };
}

function success(
  nodeIds: string[] = [],
  edgeIds: string[] = [],
): Extract<CommandResult, { ok: true }> {
  return { ok: true, changed: true, affectedNodeIds: nodeIds, affectedEdgeIds: edgeIds };
}

type AppliedCommand = {
  ok: true;
  document: WorkflowDefinition;
  result: Extract<CommandResult, { ok: true }>;
};

function applied(
  document: WorkflowDefinition,
  result: Extract<CommandResult, { ok: true }>,
): AppliedCommand {
  return { ok: true, document, result };
}

function hasNode(document: WorkflowDefinition, nodeId: string): boolean {
  return document.nodes.some((node) => node.id === nodeId);
}

function nodeAt(document: WorkflowDefinition, nodeId: string): WorkflowNode | undefined {
  return document.nodes.find((node) => node.id === nodeId);
}

function validateDocument(document: WorkflowDefinition): boolean {
  return WorkflowDefinitionSchema.safeParse(document).success;
}

function applyNodePatch(node: WorkflowNode, patch: EditorNodePatch): WorkflowNode {
  return { ...node, ...patch } as WorkflowNode;
}

function applyEdgePatch(
  edge: WorkflowDefinition["edges"][number],
  patch: EditorEdgePatch,
): WorkflowDefinition["edges"][number] {
  return { ...edge, ...patch };
}

function validNodePatch(node: WorkflowNode, patch: EditorNodePatch): boolean {
  return NodeSchema.safeParse(applyNodePatch(node, patch)).success;
}

function validEdgePatch(
  edge: WorkflowDefinition["edges"][number],
  patch: EditorEdgePatch,
): boolean {
  return WorkflowEdgeSchema.safeParse(applyEdgePatch(edge, patch)).success;
}

function validInput(
  document: WorkflowDefinition,
  input: WorkflowDefinition["inputs"][number],
): boolean {
  return validateDocument({ ...document, inputs: [...document.inputs, input] });
}

/**
 * Apply exactly one editor command. The function is pure: failed commands
 * return without a document, making rollback and history handling explicit to
 * the Zustand store.
 */
export function applyEditorCommand(
  document: WorkflowDefinition,
  command: EditorCommand,
  _ids?: EditorIdFactory,
): AppliedCommand | CommandResult {
  const next = structuredClone(document);

  switch (command.type) {
    case "add_node": {
      if (hasNode(next, command.node.id))
        return failure("duplicate_id", `Node '${command.node.id}' already exists.`);
      if (!NodeSchema.safeParse(command.node).success)
        return failure(
          "invalid_node",
          `Node '${command.node.id}' does not satisfy the workflow contract.`,
        );
      next.nodes.push(structuredClone(command.node));
      return applied(next, success([command.node.id]));
    }
    case "remove_node": {
      if (!hasNode(next, command.nodeId))
        return failure("missing_node", `Node '${command.nodeId}' does not exist.`);
      next.nodes = next.nodes.filter((node) => node.id !== command.nodeId);
      next.edges = next.edges.filter(
        (edge) => edge.source !== command.nodeId && edge.target !== command.nodeId,
      );
      return applied(
        next,
        success(
          [command.nodeId],
          document.edges
            .filter((edge) => edge.source === command.nodeId || edge.target === command.nodeId)
            .map((edge) => edge.id),
        ),
      );
    }
    case "update_node": {
      const index = next.nodes.findIndex((node) => node.id === command.nodeId);
      if (index < 0) return failure("missing_node", `Node '${command.nodeId}' does not exist.`);
      const current = next.nodes[index];
      if (!current || !validNodePatch(current, command.patch))
        return failure("invalid_node", `Patch for node '${command.nodeId}' is not valid.`);
      next.nodes[index] = applyNodePatch(current, structuredClone(command.patch));
      return applied(next, success([command.nodeId]));
    }
    case "add_edge": {
      if (next.edges.some((edge) => edge.id === command.edge.id))
        return failure("duplicate_id", `Edge '${command.edge.id}' already exists.`);
      if (!hasNode(next, command.edge.source) || !hasNode(next, command.edge.target))
        return failure("missing_node", "An edge source and target must already exist.");
      if (!WorkflowEdgeSchema.safeParse(command.edge).success)
        return failure(
          "invalid_edge",
          `Edge '${command.edge.id}' does not satisfy the workflow contract.`,
        );
      next.edges.push(structuredClone(command.edge));
      return applied(next, success([], [command.edge.id]));
    }
    case "remove_edge": {
      if (!next.edges.some((edge) => edge.id === command.edgeId))
        return failure("missing_edge", `Edge '${command.edgeId}' does not exist.`);
      next.edges = next.edges.filter((edge) => edge.id !== command.edgeId);
      return applied(next, success([], [command.edgeId]));
    }
    case "update_edge": {
      const index = next.edges.findIndex((edge) => edge.id === command.edgeId);
      if (index < 0) return failure("missing_edge", `Edge '${command.edgeId}' does not exist.`);
      const current = next.edges[index];
      if (!current || !validEdgePatch(current, command.patch))
        return failure("invalid_edge", `Patch for edge '${command.edgeId}' is not valid.`);
      next.edges[index] = applyEdgePatch(current, structuredClone(command.patch));
      return applied(next, success([], [command.edgeId]));
    }
    case "set_branch_label": {
      const edge = next.edges.find((candidate) => candidate.id === command.edgeId);
      if (!edge) return failure("missing_edge", `Edge '${command.edgeId}' does not exist.`);
      if (command.label.trim().length === 0)
        return failure("invalid_command", "A branch label cannot be empty.");
      const source = nodeAt(next, edge.source);
      if (!source || source.kind !== "route")
        return failure("invalid_command", "Branch labels can only be assigned to route edges.");
      edge.label = command.label.trim();
      return applied(next, success([], [command.edgeId]));
    }
    case "set_join_policy": {
      const node = nodeAt(next, command.nodeId);
      if (!node) return failure("missing_node", `Node '${command.nodeId}' does not exist.`);
      if (node.kind !== "join")
        return failure("invalid_command", "Join policy requires a join node.");
      const candidate = {
        ...node,
        policy: command.policy,
        ...(command.quorum === undefined ? {} : { quorum: command.quorum }),
        ...(command.outputMode === undefined ? {} : { outputMode: command.outputMode }),
      };
      if (!JoinNodeSchema.safeParse(candidate).success)
        return failure("invalid_node", `Join policy for '${command.nodeId}' is not valid.`);
      const index = next.nodes.findIndex((candidateNode) => candidateNode.id === command.nodeId);
      next.nodes[index] = candidate;
      return applied(next, success([command.nodeId]));
    }
    case "add_verify_command": {
      const node = nodeAt(next, command.nodeId);
      if (!node) return failure("missing_node", `Node '${command.nodeId}' does not exist.`);
      if (node.kind !== "verify")
        return failure("invalid_command", "Verify commands require a verify node.");
      if (!VerifyCommandSchema.safeParse(command.command).success)
        return failure("invalid_command", "Verify command does not satisfy the workflow contract.");
      node.commands.push(structuredClone(command.command));
      return applied(next, success([command.nodeId]));
    }
    case "update_verify_command": {
      const node = nodeAt(next, command.nodeId);
      if (!node) return failure("missing_node", `Node '${command.nodeId}' does not exist.`);
      if (node.kind !== "verify")
        return failure("invalid_command", "Verify commands require a verify node.");
      const current = node.commands[command.index];
      if (!current)
        return failure("missing_command", `Verify command '${command.index}' does not exist.`);
      const candidate = { ...current, ...command.command };
      if (!VerifyCommandSchema.safeParse(candidate).success)
        return failure(
          "invalid_command",
          "Verify command patch does not satisfy the workflow contract.",
        );
      node.commands[command.index] = candidate;
      return applied(next, success([command.nodeId]));
    }
    case "remove_verify_command": {
      const node = nodeAt(next, command.nodeId);
      if (!node) return failure("missing_node", `Node '${command.nodeId}' does not exist.`);
      if (node.kind !== "verify")
        return failure("invalid_command", "Verify commands require a verify node.");
      if (!node.commands[command.index])
        return failure("missing_command", `Verify command '${command.index}' does not exist.`);
      if (node.commands.length <= 1)
        return failure("invalid_command", "A verify node must keep one command.");
      node.commands.splice(command.index, 1);
      return applied(next, success([command.nodeId]));
    }
    case "set_input": {
      if (!next.inputs[command.index])
        return failure("invalid_input", `Input '${command.index}' does not exist.`);
      const duplicate = next.inputs.some(
        (input, index) => index !== command.index && input.name === command.input.name,
      );
      if (duplicate)
        return failure("duplicate_input", `Input '${command.input.name}' already exists.`);
      const candidate = structuredClone(next.inputs);
      candidate[command.index] = structuredClone(command.input);
      const workflowCandidate = { ...next, inputs: candidate };
      if (!validateDocument(workflowCandidate))
        return failure("invalid_input", "Input does not satisfy the workflow contract.");
      next.inputs = candidate;
      return applied(next, success());
    }
    case "add_input": {
      if (next.inputs.some((input) => input.name === command.input.name))
        return failure("duplicate_input", `Input '${command.input.name}' already exists.`);
      if (!validInput(next, command.input))
        return failure("invalid_input", "Input does not satisfy the workflow contract.");
      next.inputs.push(structuredClone(command.input));
      return applied(next, success());
    }
    case "remove_input": {
      if (!next.inputs.some((input) => input.name === command.name))
        return failure("invalid_input", `Input '${command.name}' does not exist.`);
      next.inputs = next.inputs.filter((input) => input.name !== command.name);
      return applied(next, success());
    }
    case "set_defaults": {
      const candidate = { ...next, defaults: structuredClone(command.defaults) };
      if (!validateDocument(candidate))
        return failure(
          "invalid_command",
          "Provider defaults do not satisfy the workflow contract.",
        );
      next.defaults = candidate.defaults;
      return applied(next, success());
    }
    case "set_policies": {
      const candidate = { ...next, policies: structuredClone(command.policies) };
      if (!validateDocument(candidate))
        return failure("invalid_command", "Policies do not satisfy the workflow contract.");
      next.policies = candidate.policies;
      return applied(next, success());
    }
    case "set_workflow_metadata": {
      const candidate = { ...next, ...structuredClone(command.patch) };
      if (!validateDocument(candidate))
        return failure(
          "invalid_command",
          "Workflow metadata does not satisfy the workflow contract.",
        );
      next.name = candidate.name;
      next.description = candidate.description;
      next.metadata = candidate.metadata;
      return applied(next, success());
    }
  }
}

export function newNodeId(ids: EditorIdFactory): string {
  return ids("node");
}

export function newEdgeId(ids: EditorIdFactory): string {
  return ids("edge");
}

export function createNode<T extends import("./types.ts").NewEditorNode>(
  node: T,
  ids: EditorIdFactory,
): T & { id: string } {
  return { ...structuredClone(node), id: newNodeId(ids) };
}

export function createEdge<T extends import("./types.ts").NewEditorEdge>(
  edge: T,
  ids: EditorIdFactory,
): T & { id: string } {
  return { ...structuredClone(edge), id: newEdgeId(ids) };
}
