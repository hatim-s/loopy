import type { Diagnostic } from "./diagnostics.js";
import { diagnostic } from "./diagnostics.js";
import { type Graph, type Node, type Ref, SCALAR_TYPES } from "./graph.js";
import type { ValidationContext as Context } from "./graph-context.js";
import {
  ancestors,
  binding,
  createContext,
  isWithin,
  sameBody,
  scopeReaches,
} from "./graph-context.js";
import { isReservedGraphName, nodeNames } from "./graph-names.js";
import { checkPredicate } from "./graph-predicate.js";
import { structureRules } from "./graph-structure.js";
import { graphTypeResolver } from "./graph-type.js";
import { isRef, refs, values } from "./graph-values.js";

function visible(context: Context, producer: Node, consumer: Node): boolean {
  const chain = [consumer, ...ancestors(consumer, context.nodes)];

  if (isWithin(context, consumer, producer.id)) {
    return false;
  }

  return chain.some(
    (node) =>
      node.id !== producer.id &&
      node.scope === producer.scope &&
      sameBody(context, node, producer) &&
      scopeReaches(context, producer.id, node.id),
  );
}

function validPath(context: Context, ref: Ref): boolean {
  if (context.resolveType(ref) === "never") {
    return false;
  }

  if (ref.path.length === 0) {
    return true;
  }

  return context.resolveType(ref) !== null;
}

function refError(context: Context, ref: Ref, consumer: Node | null): Diagnostic[] {
  if (!validPath(context, ref)) {
    return [diagnostic("unresolved_ref", consumer?.id ?? null)];
  }

  // Core reserves 'input' as the graph's external-input binding.
  if (ref.ref === "input") {
    return [];
  }

  const producer = context.nodes.get(ref.ref);
  const owner = binding(context, ref.ref);

  if (!producer && !owner) {
    return [diagnostic("unresolved_ref", consumer?.id ?? null)];
  }

  const allowed = owner
    ? bindingVisible(context, owner, consumer)
    : producer !== undefined && outputVisible(context, producer, consumer);

  return allowed ? [] : [diagnostic("out_of_scope_ref", consumer?.id ?? null)];
}

function bindingVisible(context: Context, owner: Node, consumer: Node | null): boolean {
  if (consumer === null || !isWithin(context, consumer, owner.id)) {
    return false;
  }

  if (owner.kind !== "rescue") {
    return true;
  }

  const handler = context.nodes.get(owner.handler);

  return (
    handler !== undefined &&
    [consumer, ...ancestors(consumer, context.nodes)].some(
      (node) => node.scope === owner.id && sameBody(context, node, handler),
    )
  );
}

function outputVisible(context: Context, producer: Node, consumer: Node | null): boolean {
  if (consumer === null) {
    return producer.scope === null;
  }

  return visible(context, producer, consumer);
}

function references(context: Context): Diagnostic[] {
  return [
    ...context.graph.nodes.flatMap((node) =>
      values(node)
        .flatMap(refs)
        .flatMap((ref) => refError(context, ref, node)),
    ),
    ...(context.graph.outputs === null ? [] : refError(context, context.graph.outputs, null)),
  ];
}

function predicates(context: Context): Diagnostic[] {
  return context.graph.nodes.flatMap((node) => {
    if (node.kind !== "branch") {
      return [];
    }

    return checkPredicate(node.predicate, context.resolveType).map((error) =>
      diagnostic(error.code, node.id),
    );
  });
}

function formats(context: Context): Diagnostic[] {
  return context.graph.nodes.flatMap((node) =>
    node.kind === "format" &&
    Object.values(node.values).some(
      (value) => isRef(value) && !SCALAR_TYPES.some((type) => type === context.resolveType(value)),
    )
      ? [diagnostic("operand_type", node.id)]
      : [],
  );
}

function bindings({ graph }: Context): Diagnostic[] {
  const seen = new Set<string>(["input", ...graph.nodes.map((node) => node.id)]);

  return graph.nodes.flatMap((node) => {
    const ids = bindingIds(node);

    return ids.flatMap((id) => {
      const duplicate = seen.has(id);
      seen.add(id);

      return duplicate ? [diagnostic("duplicate_ref", node.id)] : [];
    });
  });
}

function reservedNames({ graph }: Context): Diagnostic[] {
  const names = [
    ...Object.keys(graph.input).map((name) => ({ name, node: null })),
    ...graph.nodes.flatMap((node) => nodeNames(node).map((name) => ({ name, node: node.id }))),
  ];

  return names.flatMap(({ name, node }) =>
    isReservedGraphName(name)
      ? [diagnostic("reserved_name", node, `Name: ${JSON.stringify(name)}.`)]
      : [],
  );
}

export function validateGraph(graph: Graph): Diagnostic[] {
  const topology = createContext(graph);
  const context: Context = { ...topology, graph, resolveType: graphTypeResolver(graph, topology) };
  const structural = structureRules.flatMap((rule) => rule(context));

  if (structural.length) {
    return structural;
  }

  const declarations = [reservedNames, bindings].flatMap((rule) => rule(context));

  if (declarations.length) {
    return declarations;
  }

  return [references, predicates, formats].flatMap((rule) => rule(context));
}

function bindingIds(node: Node) {
  if (node.kind === "map") {
    return [node.item, node.index];
  }

  if (node.kind === "rescue") {
    return [node.error];
  }

  return [];
}
