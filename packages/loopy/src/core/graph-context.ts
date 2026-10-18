import type { Edge, Graph, Node, NodeId, RefId } from "./graph.js";
import type { ResolveType } from "./graph-predicate.js";

export type Context = {
  graph: Pick<Graph, "input" | "nodes" | "edges">;
  // References may name either node outputs or scope bindings.
  nodes: Map<NodeId | RefId, Node>;
  outgoing: Map<NodeId, Edge[]>;
  bindings: Map<RefId, Node>;
  scopeExits: Map<NodeId, Edge[]>;
};

export type ValidationContext = Context & { graph: Graph; resolveType: ResolveType };

export function createContext(graph: Context["graph"]): Context {
  const nodes = new Map<NodeId | RefId, Node>(graph.nodes.map((node) => [node.id, node]));
  const outgoing = new Map<NodeId, Edge[]>();
  const bindings = new Map<RefId, Node>();
  const scopeExits = new Map<NodeId, Edge[]>();
  for (const edge of graph.edges) {
    outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge]);
    const scope = nodes.get(edge.from)?.scope;
    if (edge.kind === "join" && scope !== null && scope !== undefined) {
      scopeExits.set(scope, [...(scopeExits.get(scope) ?? []), edge]);
    }
  }
  for (const node of graph.nodes) {
    if (node.kind === "map") {
      bindings.set(node.item, node);
      bindings.set(node.index, node);
    }
    if (node.kind === "rescue") {
      bindings.set(node.error, node);
    }
  }
  return { graph, nodes, outgoing, bindings, scopeExits };
}

export function switchTarget(
  node: Extract<Node, { kind: "switch" }>,
  label: string,
): NodeId | null {
  if (label === "default") {
    return node.default;
  }
  if (Object.hasOwn(node.cases, label)) {
    return node.cases[label] ?? null;
  }
  return null;
}

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

export function ancestors(node: Node, nodes: Context["nodes"]): Node[] {
  const result: Node[] = [];
  const seen = new Set<NodeId>([node.id]);
  let parent = node.scope === null ? undefined : nodes.get(node.scope);
  while (parent && !seen.has(parent.id)) {
    result.push(parent);
    seen.add(parent.id);
    parent = parent.scope === null ? undefined : nodes.get(parent.scope);
  }
  return result;
}

export function isWithin(context: Context, node: Node, ownerId: NodeId): boolean {
  return ancestors(node, context.nodes).some((ancestor) => ancestor.id === ownerId);
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

export function walk(
  start: NodeId,
  next: (id: NodeId) => NodeId[],
  target: (id: NodeId) => boolean,
): boolean {
  const seen = new Set<NodeId>();
  function visit(id: NodeId): boolean {
    if (target(id)) {
      return true;
    }
    if (seen.has(id)) {
      return false;
    }
    seen.add(id);
    return next(id).some(visit);
  }
  return visit(start);
}

export function scopeReaches(context: Context, from: NodeId, to: NodeId): boolean {
  const scope = context.nodes.get(from)?.scope;
  const owner = scope === null || scope === undefined ? undefined : context.nodes.get(scope);
  const entries = owner ? targets(owner) : [];
  // Visibility follows completed control scopes back into their owner's body.
  // Entering another body would let sibling arms observe one another's outputs.
  return walk(
    from,
    (id) => [
      ...(context.scopeExits.get(id) ?? [])
        .filter((edge) => context.nodes.get(edge.to)?.scope === scope)
        .map((edge) => edge.to),
      ...(context.outgoing.get(id) ?? [])
        .filter(
          (edge) =>
            (edge.kind === "next" ||
              (edge.kind === "join" && context.nodes.get(id)?.kind === "join")) &&
            context.nodes.get(edge.to)?.scope === scope &&
            !entries.includes(edge.to),
        )
        .map((edge) => edge.to),
    ],
    (id) => id === to,
  );
}

function isScopeJoin(context: Context, edge: Edge): boolean {
  const source = context.nodes.get(edge.from);
  const owner = context.nodes.get(edge.to);
  return (
    edge.kind === "join" &&
    owner?.kind === "map" &&
    source?.kind === "join" &&
    source.scope === owner.id
  );
}

export function isTail(context: Context, node: Node): boolean {
  return !(context.outgoing.get(node.id) ?? []).some((edge) => edge.kind === "next");
}

export function successors(context: Context, id: NodeId): NodeId[] {
  const node = context.nodes.get(id);
  return [
    ...(context.outgoing.get(id) ?? [])
      .filter((edge) => !isScopeJoin(context, edge))
      .map((edge) => edge.to),
    ...(node ? targets(node) : []),
  ];
}

export function reaches(context: Context, from: NodeId, to: NodeId): boolean {
  return walk(
    from,
    (id) => successors(context, id),
    (id) => id === to,
  );
}

export function binding(context: Context, ref: RefId): Node | undefined {
  return context.bindings.get(ref);
}
