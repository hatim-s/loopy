import type { ComparisonOperand, Graph, Node, NodeId, Predicate, Ref, Value } from "./graph.js";
import { isRecord } from "./validation.js";

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
  const scope = context.nodes.get(from)?.scope;
  const owner = scope === null || scope === undefined ? undefined : context.nodes.get(scope);
  const entries = owner ? targets(owner) : [];

  function visit(id: NodeId): boolean {
    if (id === to) {
      return true;
    }

    if (seen.has(id)) {
      return false;
    }

    seen.add(id);

    const control = context.nodes.get(id);

    const exits = control
      ? context.graph.edges
          .filter(
            (edge) =>
              edge.kind === "join" &&
              context.nodes.get(edge.from)?.scope === control.id &&
              context.nodes.get(edge.to)?.scope === scope,
          )
          .map((edge) => edge.to)
      : [];

    return (
      exits.some(visit) ||
      context.graph.edges.some(
        (edge) =>
          edge.from === id &&
          (edge.kind === "next" ||
            (edge.kind === "join" && context.nodes.get(id)?.kind === "join")) &&
          context.nodes.get(edge.to)?.scope === scope &&
          !entries.includes(edge.to) &&
          visit(edge.to),
      )
    );
  }

  return visit(from);
}

export function isScopeJoin(context: Context, from: NodeId, to: NodeId, kind: string): boolean {
  const source = context.nodes.get(from);
  const owner = context.nodes.get(to);

  return (
    kind === "join" &&
    owner !== undefined &&
    owner.kind === "map" &&
    source?.kind === "join" &&
    source.scope === to
  );
}

export function successors(context: Context, id: NodeId): NodeId[] {
  const node = context.nodes.get(id);

  return [
    ...context.graph.edges
      .filter((edge) => edge.from === id && !isScopeJoin(context, edge.from, edge.to, edge.kind))
      .map((edge) => edge.to),
    ...(node ? targets(node) : []),
  ];
}

export function isRef(value: Value): value is Ref {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    "ref" in value &&
    typeof value.ref === "string" &&
    "path" in value &&
    Array.isArray(value.path)
  );
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

export function predicateValues(predicate: Predicate): ComparisonOperand[] {
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

export function binding(context: Context, ref: { ref: string; path: string[] }): Node | undefined {
  return context.graph.nodes.find(
    (node) =>
      (node.kind === "map" && (node.item === ref.ref || node.index === ref.ref)) ||
      (node.kind === "rescue" && node.error === ref.ref),
  );
}
