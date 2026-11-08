import { errorMessage } from "../errors";
import type { ExecutionError } from "../executor";
import { continuation, type Context as GraphContext } from "../graph/context";
import type { NodeRun } from "../graph/node-run";
import type { Node } from "../graph/nodes";
import type { NodeId } from "../graph/values";
import type { Json } from "../json";
import { control } from "./control";
import { failNode } from "./failure";
import { immediate } from "./immediate";
import { invoke } from "./invoke";
import { type Transition, write } from "./node-run";
import { type ResolutionContext, ROOT_CONTEXT, sameExecution } from "./resolve";

export type TraversalResult =
  | { kind: "pending" }
  | { kind: "succeeded"; output: Json }
  | { kind: "failed"; error: ExecutionError }
  | { kind: "cancelled" };

export type Traversal = {
  graph: GraphContext;
  transition: Transition;
  at: string;
  rehydrate: boolean;
  cancelling: boolean;
};

function nodeAt(graph: GraphContext, id: NodeId): Node {
  const node = graph.nodes.get(id);

  if (!node) {
    throw new Error(`Graph node '${id}' is missing.`);
  }

  return node;
}

function run(
  traversal: Traversal,
  node: Node,
  options: { previous: NodeRun | undefined; context: ResolutionContext },
): TraversalResult {
  switch (node.kind) {
    case "branch":
    case "switch":
    case "map":
    case "parallel":
    case "finally":
    case "rescue":
      return control(traversal, node, options.context);
    default:
      return invoke(traversal, node, options);
  }
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
    const result = run(traversal, node, { previous, context });

    switch (result.kind) {
      case "failed":
        failNode(transition, node, { error: result.error, at, scope: context.scope });

        return result;
      case "succeeded":
        return immediate(transition, node, { output: result.output, at, context });
      case "cancelled":
        write(transition, {
          key,
          attempt: previous?.attempt ?? 1,
          maxAttempts: previous?.maxAttempts ?? 1,
          startedAt: previous?.startedAt ?? at,
          endedAt: at,
          status: "cancelled",
          receipt: previous?.receipt ?? "none",
        });

        return result;
      case "pending":
        return result;
    }
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
    id = continuation(traversal.graph, node);
  }

  return { kind: "succeeded", output };
}
