import type { Diagnostic } from ".";
import {
  ancestors,
  continuationTargets,
  isBodyTail,
  reaches,
  sameBody,
  successors,
  targets,
} from "./context";
import { type ValidationContext as Context, diagnostic } from "./validation";
import { INPUT_REF, type NodeId } from "./values";

function identity({ graph, nodes }: Context): Diagnostic[] {
  const seen = new Set<string>([INPUT_REF]);
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

function scopeEdges(context: Context): Diagnostic[] {
  return context.graph.edges.flatMap((edge) => {
    const from = context.nodes.get(edge.from);
    const to = context.nodes.get(edge.to);

    if (!from || !to) {
      return [];
    }

    const local = from.scope === to.scope && sameBody(context, from, to);
    const last = isBodyTail(context, from);
    const owner = from.scope === null ? undefined : context.nodes.get(from.scope);

    const join =
      edge.kind === "join" &&
      from.kind === "join" &&
      last &&
      owner &&
      (to.id === owner.id || (to.kind === "join" && to.scope === owner.scope));

    return local || join
      ? []
      : [
          diagnostic(
            "invalid_scope",
            from.id,
            "Edges must stay within a body or leave it through a join.",
          ),
        ];
  });
}

// The engine follows one continuation, so a second target would silently never run.
function continuations(context: Context): Diagnostic[] {
  return context.graph.nodes.flatMap((node) =>
    continuationTargets(context, node).length > 1
      ? [diagnostic("invalid_scope", node.id, "A node must continue to exactly one next node.")]
      : [],
  );
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
  continuations,
  connectivity,
  cycles,
];
