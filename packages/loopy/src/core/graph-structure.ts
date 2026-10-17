import type { Diagnostic, Edge, Node, NodeId } from "./graph.js";
import { ancestors, reaches, sameBody, successors, targets } from "./graph-context.js";
import { type ValidationContext as Context, diagnostic } from "./graph-validation.js";

function identity({ graph, nodes }: Context): Diagnostic[] {
  const seen = new Set<string>(["input"]);
  const errors: Diagnostic[] = [];

  for (const node of graph.nodes) {
    if (seen.has(node.id)) {
      errors.push(diagnostic("duplicate_node", node.id, "Node ids must be unique."));
    }

    seen.add(node.id);
  }

  if (!nodes.has(graph.entry)) {
    errors.push(diagnostic("missing_entry", graph.entry, "Entry must name a node."));
  }

  return errors;
}

function endpoints({ graph, nodes }: Context): Diagnostic[] {
  const errors = graph.edges.flatMap((edge) =>
    [edge.from, edge.to].flatMap((id) =>
      nodes.has(id) ? [] : [diagnostic("missing_endpoint", id, "Edge endpoints must name nodes.")],
    ),
  );

  for (const node of graph.nodes) {
    for (const id of targets(node)) {
      if (!nodes.has(id)) {
        errors.push(
          diagnostic(
            node.kind === "branch" ? "missing_arm" : "missing_endpoint",
            node.id,
            "Control targets must name nodes.",
          ),
        );
      }
    }
  }

  return errors;
}

function scopes({ graph, nodes }: Context): Diagnostic[] {
  return graph.nodes.flatMap((node) => {
    const parent = node.scope === null ? undefined : nodes.get(node.scope);

    const badParent =
      node.scope !== null &&
      (!parent ||
        targets(parent).length === 0 ||
        parent.id === node.id ||
        ancestors(parent, nodes).some((ancestor) => ancestor.id === node.id));

    const badChild = targets(node).some((id) => {
      const child = nodes.get(id);

      return child && child.scope !== node.id;
    });

    return badParent || badChild
      ? [
          diagnostic(
            "invalid_scope",
            node.id,
            "Control bodies must belong to their enclosing scope.",
          ),
        ]
      : [];
  });
}

function controlTarget(node: Node, edge: Edge): boolean {
  switch (edge.kind) {
    case "yes":
    case "no":
      return node.kind === "branch" && node.arms[edge.kind] === edge.to;
    case "case":
      return node.kind === "switch"
        ? (edge.label === "default" ? node.default : node.cases[edge.label]) === edge.to
        : node.kind === "parallel" && node.branches[edge.label] === edge.to;
    case "each":
      return node.kind === "map" && node.body === edge.to;
    case "cleanup":
      return node.kind === "finally" && node.cleanup === edge.to;
    case "rescue":
      return node.kind === "rescue" && node.handler === edge.to;
    default:
      return true;
  }
}

function controlEdges({ graph, nodes }: Context): Diagnostic[] {
  return graph.edges.flatMap((edge) => {
    const node = nodes.get(edge.from);

    return node && !controlTarget(node, edge)
      ? [
          diagnostic(
            "invalid_scope",
            node.id,
            "Control edges must match their owner and declared target.",
          ),
        ]
      : [];
  });
}

function scopeEdges(context: Context): Diagnostic[] {
  return context.graph.edges.flatMap((edge) => {
    const from = context.nodes.get(edge.from);
    const to = context.nodes.get(edge.to);

    if (!from || !to) {
      return [];
    }

    const local = from.scope === to.scope && sameBody(context, from, to);
    const entry = targets(from).includes(to.id) && to.scope === from.id;
    const last = !context.graph.edges.some((next) => next.from === from.id && next.kind === "next");
    const owner = from.scope === null ? undefined : context.nodes.get(from.scope);

    const join =
      edge.kind === "join" &&
      from.kind === "join" &&
      last &&
      owner &&
      (to.id === owner.id || (to.kind === "join" && to.scope === owner.scope));

    return local || entry || join
      ? []
      : [
          diagnostic(
            "invalid_scope",
            from.id,
            "Edges must stay within a body or use its entry or join.",
          ),
        ];
  });
}

function connectivity(context: Context): Diagnostic[] {
  if (!context.nodes.has(context.graph.entry)) {
    return [];
  }

  return context.graph.nodes.flatMap((node) =>
    reaches(context, context.graph.entry, node.id)
      ? []
      : [
          diagnostic(
            "invalid_scope",
            node.id,
            "Every node must be reachable from the graph entry.",
          ),
        ],
  );
}

function cycles(context: Context): Diagnostic[] {
  const visited = new Set<string>();
  const active = new Set<string>();

  function visit(id: NodeId): boolean {
    if (active.has(id)) {
      return true;
    }

    if (visited.has(id)) {
      return false;
    }

    visited.add(id);
    active.add(id);
    const cyclic = successors(context, id).some(visit);
    active.delete(id);

    return cyclic;
  }

  return context.graph.nodes.some((node) => visit(node.id))
    ? [diagnostic("cycle", null, "Graphs must be acyclic except for scope joins.")]
    : [];
}

export const structureRules = [
  identity,
  endpoints,
  scopes,
  scopeEdges,
  controlEdges,
  connectivity,
  cycles,
];
