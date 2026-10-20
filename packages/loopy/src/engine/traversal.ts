import {
  type ExecutionError,
  errorMessage,
  type Graph,
  type Json,
  type Node,
  type NodeId,
} from "../core/index.js";
import { controls } from "./control.js";
import { failNode } from "./failure.js";
import { immediate } from "./immediate.js";
import { invoke } from "./invoke.js";
import { type Transition, write } from "./node-run.js";
import { type ResolutionContext, ROOT_CONTEXT, sameExecution } from "./resolve.js";

export type TraversalResult =
  | { kind: "pending" }
  | { kind: "succeeded"; output: Json }
  | { kind: "failed"; error: ExecutionError }
  | { kind: "cancelled" };

export type Traversal = {
  graph: Graph;
  transition: Transition;
  at: string;
  rehydrate: boolean;
  cancelling: boolean;
};

export function nodeAt(graph: Graph, id: NodeId): Node {
  const node = graph.nodes.find((node) => node.id === id);

  if (!node) {
    throw new Error(`Graph node '${id}' is missing.`);
  }

  return node;
}

function within(graph: Graph, id: NodeId, owner: NodeId): boolean {
  let parent: NodeId | null = id;

  while (parent !== null) {
    if (parent === owner) {
      return true;
    }

    parent = nodeAt(graph, parent).scope;
  }

  return false;
}

function next(graph: Graph, node: Node): NodeId | undefined {
  // A control's arm tails point to its continuation in the parent's lexical scope.
  return graph.edges.find(
    (edge) =>
      (edge.kind === "next" || edge.kind === "join") &&
      nodeAt(graph, edge.to).scope === node.scope &&
      (edge.from === node.id || within(graph, edge.from, node.id)),
  )?.to;
}

export function evaluate(
  traversal: Traversal,
  node: Node,
  context: ResolutionContext,
): TraversalResult {
  const { transition, at } = traversal;
  const key = { runId: transition.state.runId, nodeId: node.id, scope: context.scope };
  const previous = transition.state.nodeRuns.find((run) => sameExecution(run.key, key));

  if (previous?.status === "succeeded") {
    return { kind: "succeeded", output: previous.output };
  }

  if (previous?.status === "failed") {
    return { kind: "failed", error: previous.error };
  }

  if (previous?.status === "cancelled") {
    return { kind: "cancelled" };
  }

  try {
    const result =
      controls(traversal, node, context) ?? invoke(traversal, node, { previous, context });

    if (result.kind === "failed") {
      failNode(transition, node, { error: result.error, at, scope: context.scope });
    } else if (result.kind === "succeeded") {
      immediate(transition, node, { output: result.output, at, context });
      const stored = transition.state.nodeRuns.find((run) => sameExecution(run.key, key));

      if (stored?.status === "failed") {
        return { kind: "failed", error: stored.error };
      }
    }

    if (result.kind === "cancelled") {
      write(transition, {
        key,
        attempt: previous?.attempt ?? 1,
        maxAttempts: previous?.maxAttempts ?? 1,
        startedAt: previous?.startedAt ?? at,
        endedAt: at,
        status: "cancelled",
        receipt: previous?.receipt ?? "none",
      });
    }

    return result;
  } catch (cause) {
    const error: ExecutionError = { code: "validation", message: errorMessage(cause) };
    failNode(transition, node, { error, at, scope: context.scope });

    return { kind: "failed", error };
  }
}

export function sequence(
  traversal: Traversal,
  entry: NodeId,
  context = ROOT_CONTEXT,
): TraversalResult {
  const owner = nodeAt(traversal.graph, entry).scope;
  let id: NodeId | undefined = entry;
  let output: Json = null;
  const visited = new Set<NodeId>();

  while (id !== undefined) {
    if (visited.has(id)) {
      throw new Error(`Control traversal cycle at '${id}'.`);
    }

    visited.add(id);
    const node = nodeAt(traversal.graph, id);

    if (node.scope !== owner) {
      break;
    }

    const result = evaluate(traversal, node, context);

    if (result.kind !== "succeeded") {
      return result;
    }

    output = result.output;
    id = next(traversal.graph, node);
  }

  return { kind: "succeeded", output };
}
