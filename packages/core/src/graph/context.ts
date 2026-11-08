import { isRecord } from "../validation";
import type { Edge, Graph } from ".";
import type { Node } from "./nodes";
import { isRef } from "./ref";
import type { ComparisonOperand, NodeId, Predicate, Ref, RefLookup, Value } from "./values";

export type Context = {
  graph: Pick<Graph, "input" | "nodes" | "edges">;
  nodes: Map<string, Node>;
};

export function targets(node: Node): NodeId[] {
  switch (node.kind) {
    case "branch":
      return Object.values(node.arms);
    case "switch":
      return [...Object.values(node.cases), ...(node.default === null ? [] : [node.default])];
    case "map":
      return [node.body];
    case "parallel":
      return Object.values(node.branches);
    case "finally":
      return [node.body, node.cleanup];
    case "rescue":
      return [node.body, node.handler];
    default:
      return [];
  }
}

export function ancestors(node: Node, nodes: Map<string, Node>): Node[] {
  const result: Node[] = [];
  const seen = new Set<string>([node.id]);
  let parent = node.scope === null ? undefined : nodes.get(node.scope);

  while (parent && !seen.has(parent.id)) {
    result.push(parent);
    seen.add(parent.id);
    parent = parent.scope === null ? undefined : nodes.get(parent.scope);
  }

  return result;
}

export function bodyEntries(context: Context, node: Node): NodeId[] {
  const owner = node.scope === null ? undefined : context.nodes.get(node.scope);

  return owner ? targets(owner).filter((entry) => scopeReaches(context, entry, node.id)) : [];
}

export function sameBody(context: Context, left: Node, right: Node): boolean {
  if (left.scope === null && right.scope === null) {
    return true;
  }

  const entries = bodyEntries(context, left);
  const other = bodyEntries(context, right);

  return entries.length === 1 && other.length === 1 && entries[0] === other[0];
}

export function scopeReaches(context: Context, from: NodeId, to: NodeId): boolean {
  const seen = new Set<NodeId>();

  function visit(id: NodeId): boolean {
    if (id === to) {
      return true;
    }

    if (seen.has(id)) {
      return false;
    }

    seen.add(id);
    const node = context.nodes.get(id);

    return node !== undefined && continuationTargets(context, node).some(visit);
  }

  return visit(from);
}

// A map body's join edge returns to the map for the next item; it never continues the graph.
function isScopeJoin(context: Context, edge: Edge): boolean {
  const source = context.nodes.get(edge.from);
  const owner = context.nodes.get(edge.to);

  return (
    edge.kind === "join" &&
    owner?.kind === "map" &&
    source?.kind === "join" &&
    source.scope === edge.to
  );
}

export function successors(context: Context, id: NodeId): NodeId[] {
  const node = context.nodes.get(id);

  return [
    ...context.graph.edges
      .filter((edge) => edge.from === id && !isScopeJoin(context, edge))
      .map((edge) => edge.to),
    ...(node ? targets(node) : []),
  ];
}

/**
 * The nodes that run after `node` in its own scope. A control's arm tails lead there too, so
 * edges from its descendants count. A valid graph has at most one.
 */
export function continuationTargets(context: Context, node: Node): NodeId[] {
  const found = context.graph.edges.flatMap((edge) => {
    const from = context.nodes.get(edge.from);

    return !isScopeJoin(context, edge) &&
      context.nodes.get(edge.to)?.scope === node.scope &&
      from !== undefined &&
      (from.id === node.id || ancestors(from, context.nodes).some(({ id }) => id === node.id))
      ? [edge.to]
      : [];
  });

  return [...new Set(found)];
}

export function continuation(context: Context, node: Node): NodeId | undefined {
  return continuationTargets(context, node)[0];
}

export function isBodyTail(context: Context, node: Node): boolean {
  return continuationTargets(context, node).length === 0;
}

export function refs(value: Value): Ref[] {
  if (isRef(value)) {
    return [value];
  }

  if (Array.isArray(value)) {
    return value.flatMap(refs);
  }

  if (isRecord(value)) {
    return Object.values(value).flatMap(refs);
  }

  return [];
}

function predicateValues(predicate: Predicate): ComparisonOperand[] {
  switch (predicate.op) {
    case "and":
    case "or":
      return predicate.predicates.flatMap(predicateValues);
    case "not":
      return predicateValues(predicate.predicate);
    case "exists":
    case "isNull":
      return [predicate.value];
    default:
      return [predicate.left, predicate.right];
  }
}

export function values(node: Node): Value[] {
  switch (node.kind) {
    case "code":
      return Object.values(node.in);
    case "command":
      return [
        ...node.argv,
        ...Object.values(node.flags),
        node.options.cwd,
        ...Object.values(node.options.env),
        node.options.stdin,
      ];
    case "branch":
      return predicateValues(node.predicate);
    case "switch":
      return [node.on];
    case "map":
      return [node.over];
    case "fail":
      return [node.message];
    case "format":
      return Object.values(node.values);
    case "log":
      return [node.message, node.data];
    case "join":
      return node.result.kind === "none" ? [] : [node.result.value];
    default:
      return [];
  }
}

export function reaches(context: Context, from: NodeId, to: NodeId): boolean {
  const seen = new Set<string>();

  function visit(id: NodeId): boolean {
    if (id === to) {
      return true;
    }

    if (seen.has(id)) {
      return false;
    }

    seen.add(id);

    return successors(context, id).some(visit);
  }

  return visit(from);
}

export function binding(context: Context, ref: RefLookup): Node | undefined {
  return context.graph.nodes.find(
    (node) =>
      (node.kind === "map" && (node.item === ref.ref || node.index === ref.ref)) ||
      (node.kind === "rescue" && node.error === ref.ref),
  );
}
