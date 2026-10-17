import type { Diagnostic, Graph, Node, Ref } from "./graph.js";
import {
  ancestors,
  binding,
  bodyEntries,
  isRef,
  refs,
  sameBody,
  scopeReaches,
  values,
} from "./graph-context.js";
import { checkPredicate, hasSize } from "./graph-predicate.js";
import { structureRules } from "./graph-structure.js";
import { graphTypeResolver } from "./graph-type.js";
import { type ValidationContext as Context, diagnostic } from "./graph-validation.js";

function visible(context: Context, producer: Node, consumer: Node): boolean {
  const chain = [consumer, ...ancestors(consumer, context.nodes)];

  if (chain.slice(1).some((node) => node.id === producer.id)) {
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

function validPath(context: Context, ref: { ref: string; path: string[] }): boolean {
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
    return [
      diagnostic(
        "unresolved_ref",
        consumer?.id ?? null,
        "Reference paths must match the declared output schema.",
      ),
    ];
  }

  // The compiler reserves 'input' as the graph's external-input binding.
  if (ref.ref === "input") {
    return [];
  }

  const producer = context.nodes.get(ref.ref);
  const owner = binding(context, ref);

  if (!producer && !owner) {
    return [
      diagnostic(
        "unresolved_ref",
        consumer?.id ?? null,
        "References must name an output or a scope binding.",
      ),
    ];
  }

  const local =
    owner && consumer && ancestors(consumer, context.nodes).some((node) => node.id === owner.id);

  const handler =
    owner?.kind !== "rescue" ||
    (consumer &&
      [consumer, ...ancestors(consumer, context.nodes)].some((node) => {
        const entries = bodyEntries(context, node);

        return node.scope === owner.id && entries.length === 1 && entries[0] === owner.handler;
      }));

  const allowed = owner
    ? local && handler
    : producer && (consumer ? visible(context, producer, consumer) : producer.scope === null);

  return allowed
    ? []
    : [
        diagnostic(
          "out_of_scope_ref",
          consumer?.id ?? null,
          "Reference is unavailable in this scope.",
        ),
      ];
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
  return context.graph.nodes.flatMap((node) =>
    node.kind === "branch"
      ? checkPredicate(node.predicate, (ref) => context.resolveType(ref)).map((error) =>
          diagnostic(error.code, node.id, error.message),
        )
      : values(node).some(hasSize)
        ? [diagnostic("invalid_size", node.id, "Size is allowed only in comparisons.")]
        : [],
  );
}

function formats(context: Context): Diagnostic[] {
  return context.graph.nodes.flatMap((node) =>
    node.kind === "format" &&
    Object.values(node.values).some(
      (value) =>
        isRef(value) && !["string", "number", "boolean"].includes(context.resolveType(value) ?? ""),
    )
      ? [diagnostic("predicate_type", node.id, "Format operands must have a declared scalar type.")]
      : [],
  );
}

function bindings({ graph }: Context): Diagnostic[] {
  const seen = new Set<string>(["input", ...graph.nodes.map((node) => node.id)]);

  return graph.nodes.flatMap((node) => {
    const ids =
      node.kind === "map" ? [node.item, node.index] : node.kind === "rescue" ? [node.error] : [];

    return ids.flatMap((id) => {
      const duplicate = seen.has(id);
      seen.add(id);

      return duplicate
        ? [diagnostic("duplicate_ref", node.id, "Scope bindings must have unique reference ids.")]
        : [];
    });
  });
}

export function validateGraph(graph: Graph): Diagnostic[] {
  const context: Context = {
    graph,
    nodes: new Map(graph.nodes.map((node) => [node.id, node])),
    resolveType: graphTypeResolver(graph),
  };

  return [...structureRules, bindings, references, predicates, formats].flatMap((rule) =>
    rule(context),
  );
}
