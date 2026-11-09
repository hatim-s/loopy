import { errorMessage } from "../errors";
import type { ExecutionError } from "../executor";
import { continuation, type Context as GraphContext } from "../graph/context";
import { sameExecution } from "../graph/key";
import type { Node } from "../graph/nodes";
import type { NodeId } from "../graph/values";
import type { Json } from "../json";
import { control } from "./control";
import { failNode } from "./failure";
import { immediate } from "./immediate";
import { type InvokeResult, invoke } from "./invoke";
import { type Execution, runBase, type Transition, write } from "./node-run";
import { type ResolutionContext, ROOT_CONTEXT } from "./resolve";

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

function run(traversal: Traversal, execution: Execution): InvokeResult {
  const { node } = execution;

  switch (node.kind) {
    case "branch":
    case "switch":
    case "map":
    case "parallel":
    case "finally":
    case "rescue":
      return control(traversal, node, execution.context);
    default:
      return invoke(traversal, { ...execution, node });
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
  const execution = { node, key, previous, context };

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
    const result = run(traversal, execution);

    switch (result.kind) {
      case "failed":
        failNode(transition, execution, { error: result.error, at });

        return result;
      case "succeeded":
        return immediate(transition, execution, { output: result.output, log: null, at });
      case "logged":
        return immediate(transition, execution, { output: null, log: result.log, at });
      case "cancelled":
        write(transition, { ...runBase(execution, at), endedAt: at, status: "cancelled" });

        return result;
      case "pending":
        return result;
    }
  } catch (cause) {
    const error: ExecutionError = { code: "validation", message: errorMessage(cause) };
    failNode(transition, execution, { error, at });

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
