import type { Diagnostic } from "./diagnostics.js";
import { diagnostic } from "./diagnostics.js";
import type { ValidationContext as Context } from "./graph-context.js";
import { isTail, isWithin, reaches, sameBody, successors, targets, walk } from "./graph-context.js";

function identity({ graph, nodes }: Context): Diagnostic[] {
  const seen = new Set<string>(["input"]);
  const errors: Diagnostic[] = [];

  for (const node of graph.nodes) {
    if (seen.has(node.id)) {
      errors.push(diagnostic("duplicate_node", node.id));
    }

    seen.add(node.id);
  }

  if (!nodes.has(graph.entry)) {
    errors.push(diagnostic("missing_entry", graph.entry));
  }

  return errors;
}

function endpoints({ graph, nodes }: Context): Diagnostic[] {
  const errors = graph.edges.flatMap((edge) =>
    [edge.from, edge.to].flatMap((id) =>
      nodes.has(id) ? [] : [diagnostic("missing_endpoint", id)],
    ),
  );

  for (const node of graph.nodes) {
    for (const id of targets(node)) {
      if (!nodes.has(id)) {
        errors.push(
          diagnostic(node.kind === "branch" ? "missing_arm" : "missing_endpoint", node.id),
        );
      }
    }
  }

  return errors;
}

function scopes(context: Context): Diagnostic[] {
  const { graph, nodes } = context;

  return graph.nodes.flatMap((node) => {
    const parent = node.scope === null ? undefined : nodes.get(node.scope);

    const badParent =
      node.scope !== null &&
      (!parent ||
        targets(parent).length === 0 ||
        parent.id === node.id ||
        isWithin(context, parent, node.id));

    const badChild = targets(node).some((id) => {
      const child = nodes.get(id);

      return child && child.scope !== node.id;
    });

    return badParent || badChild ? [diagnostic("invalid_scope", node.id)] : [];
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
    const last = isTail(context, from);
    const owner = from.scope === null ? undefined : context.nodes.get(from.scope);

    const join =
      edge.kind === "join" &&
      from.kind === "join" &&
      last &&
      owner &&
      (to.id === owner.id || (to.kind === "join" && to.scope === owner.scope));

    return local || entry || join ? [] : [diagnostic("scope_escape", from.id)];
  });
}

function connectivity(context: Context): Diagnostic[] {
  if (!context.nodes.has(context.graph.entry)) {
    return [];
  }

  return context.graph.nodes.flatMap((node) =>
    reaches(context, context.graph.entry, node.id) ? [] : [diagnostic("unreachable", node.id)],
  );
}

function cycles(context: Context): Diagnostic[] {
  const cyclic = walk(
    context.graph.nodes.map((node) => node.id),
    (id) => successors(context, id),
    (id, path) => path.has(id),
  );

  return cyclic ? [diagnostic("cycle", null)] : [];
}

export const structureRules = [identity, endpoints, scopes, scopeEdges, connectivity, cycles];
