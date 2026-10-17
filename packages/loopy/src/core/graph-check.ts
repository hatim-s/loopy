import type {
  ComparisonOperand,
  Diagnostic,
  DiagnosticCode,
  Graph,
  Node,
  NodeId,
  Predicate,
  RecordSpec,
  Ref,
  Value,
} from "./graph.js";
import { isBoolean, isNumber, isRecord, isString } from "./validation.js";

type Context = { graph: Graph; nodes: Map<string, Node> };

function diagnostic(code: DiagnosticCode, node: NodeId | null, message: string): Diagnostic {
  return { code, node, message, source: null };
}

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

function targets(node: Node): NodeId[] {
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

function ancestors(node: Node, nodes: Map<string, Node>): Node[] {
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

function isMapBackEdge(context: Context, from: NodeId, to: NodeId, kind: string): boolean {
  const source = context.nodes.get(from);

  return (
    kind === "join" &&
    context.nodes.get(to)?.kind === "map" &&
    source?.kind === "join" &&
    source.scope === to
  );
}

function successors(context: Context, id: NodeId): NodeId[] {
  const node = context.nodes.get(id);

  return [
    ...context.graph.edges
      .filter((edge) => edge.from === id && !isMapBackEdge(context, edge.from, edge.to, edge.kind))
      .map((edge) => edge.to),
    ...(node ? targets(node) : []),
  ];
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
    ? [diagnostic("cycle", null, "Graphs must be acyclic except for map iteration edges.")]
    : [];
}

function isRef(value: Value): value is Ref {
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

function refs(value: Value): Ref[] {
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

function values(node: Node): Value[] {
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
      return [node.result];
    default:
      return [];
  }
}

function reaches(context: Context, from: NodeId, to: NodeId): boolean {
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

function binding(context: Context, ref: Ref): Node | undefined {
  return context.graph.nodes.find(
    (node) =>
      (node.kind === "map" && (node.item === ref.ref || node.index === ref.ref)) ||
      (node.kind === "rescue" && node.error === ref.ref),
  );
}

function visible(context: Context, producer: Node, consumer: Node): boolean {
  const chain = [consumer, ...ancestors(consumer, context.nodes)];

  if (chain.slice(1).some((node) => node.id === producer.id)) {
    return true;
  }

  return chain.some(
    (node) =>
      node.id !== producer.id &&
      node.scope === producer.scope &&
      reaches(context, producer.id, node.id),
  );
}

function validPath(context: Context, ref: Ref): boolean {
  const schema = declaredSchema(context, ref);

  if (schema && schema !== "schema" && schema !== "json" && ref.path.length > 0) {
    const field = ref.path[0] ?? "";
    const type = schema[field] ?? schema[`${field}?`];

    return type !== undefined && (ref.path.length === 1 || type === "json");
  }

  const owner = binding(context, ref);

  if (owner?.kind === "map" && owner.index === ref.ref) {
    return ref.path.length === 0;
  }

  if (owner?.kind === "rescue") {
    return (
      ref.path.length === 0 ||
      (ref.path.length === 1 && ["message", "code"].includes(ref.path[0] ?? ""))
    );
  }

  const node = context.nodes.get(ref.ref);

  return !node || !["format", "now", "uuid", "random"].includes(node.kind) || ref.path.length === 0;
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
    owner?.kind !== "rescue" || (consumer && reaches(context, owner.handler, consumer.id));

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

function declaredSchema(context: Context, ref: Ref) {
  if (ref.ref === "input") {
    return context.graph.input;
  }

  const node = context.nodes.get(ref.ref);

  if (node?.kind === "code") {
    return node.out;
  }

  return node?.kind === "wait" ? node.payload : null;
}

function recordPathType(schema: RecordSpec, path: string[]): string | null {
  if (path.length === 0) {
    return "object";
  }

  const field = path[0] ?? "";
  const type = schema[field] ?? schema[`${field}?`];

  if (path.length !== 1 || type === "json") {
    return null;
  }

  return type ?? null;
}

function schemaType(context: Context, ref: Ref): string | null {
  const node = context.nodes.get(ref.ref);
  const owner = binding(context, ref);

  if (owner?.kind === "map" && owner.index === ref.ref) {
    return ref.path.length === 0 ? "number" : null;
  }

  if (owner?.kind === "rescue") {
    return ref.path.length === 1 && ["message", "code"].includes(ref.path[0] ?? "")
      ? "string"
      : null;
  }

  const schema = declaredSchema(context, ref);

  if (schema && schema !== "schema" && schema !== "json") {
    return recordPathType(schema, ref.path);
  }

  if (ref.path.length > 0) {
    return null;
  }

  if (node?.kind === "format" || node?.kind === "now" || node?.kind === "uuid") {
    return "string";
  }

  if (node?.kind === "random") {
    return "number";
  }

  if (node?.kind === "map") {
    return "array";
  }

  return null;
}

function operandType(context: Context, value: ComparisonOperand): string | null {
  if (isRef(value)) {
    return "size" in value ? "number" : schemaType(context, value);
  }

  if (value === null) {
    return "null";
  }

  if (Array.isArray(value)) {
    return "array";
  }

  if (isString(value)) {
    return "string";
  }

  if (isNumber(value)) {
    return "number";
  }

  if (isBoolean(value)) {
    return "boolean";
  }

  return "object";
}

function hasSize(value: Value): boolean {
  return refs(value).some((ref) => "size" in ref);
}

function comparisonErrors(
  context: Context,
  predicate: Extract<Predicate, { left: ComparisonOperand }>,
  node: NodeId,
): Diagnostic[] {
  const left = operandType(context, predicate.left);
  const right = operandType(context, predicate.right);

  const invalidSize = [predicate.left, predicate.right].some((operand) => {
    if (!isRef(operand) || !("size" in operand)) {
      return hasSize(operand);
    }

    const type = schemaType(context, operand);

    return operand.size !== true || (type !== null && type !== "string" && type !== "array");
  });

  if (invalidSize) {
    return [
      diagnostic(
        "invalid_size",
        node,
        "Size requires a string or array reference in a comparison.",
      ),
    ];
  }

  const mismatch =
    predicate.op === "in"
      ? right !== null && right !== "array"
      : left !== null && right !== null && left !== right;

  const members = predicate.op === "in" && Array.isArray(predicate.right) ? predicate.right : [];

  const badMember =
    left !== null && members.some((member) => operandType(context, member) !== left);

  return mismatch || badMember
    ? [diagnostic("predicate_type", node, "Predicate operands must have matching declared types.")]
    : [];
}

function predicateErrors(context: Context, predicate: Predicate, node: NodeId): Diagnostic[] {
  switch (predicate.op) {
    case "and":
    case "or":
      return predicate.predicates.flatMap((child) => predicateErrors(context, child, node));
    case "not":
      return predicateErrors(context, predicate.predicate, node);
    case "exists":
    case "isNull":
      return hasSize(predicate.value)
        ? [diagnostic("invalid_size", node, "Size is allowed only in comparisons.")]
        : [];
    default:
      return comparisonErrors(context, predicate, node);
  }
}

function predicates(context: Context): Diagnostic[] {
  return context.graph.nodes.flatMap((node) =>
    node.kind === "branch"
      ? predicateErrors(context, node.predicate, node.id)
      : values(node).some(hasSize)
        ? [diagnostic("invalid_size", node.id, "Size is allowed only in comparisons.")]
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

const rules = [identity, bindings, endpoints, scopes, references, predicates, cycles];

export function validateGraph(graph: Graph): Diagnostic[] {
  const context = { graph, nodes: new Map(graph.nodes.map((node) => [node.id, node])) };

  return rules.flatMap((rule) => rule(context));
}
