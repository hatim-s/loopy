import {
  ERROR_FIELDS,
  type Graph,
  type Node,
  type NodeId,
  type RecordSpec,
  type Value,
} from "./graph.js";
import {
  binding,
  type Context as GraphContext,
  isRef,
  scopeReaches,
  targets,
} from "./graph-context.js";
import { operandType } from "./graph-predicate.js";
import { isRecord } from "./validation.js";

type Context = GraphContext & { refTypes: Map<string, string | null>; resolving: Set<string> };

function declaredSchema(context: Context, ref: { ref: string; path: string[] }) {
  if (ref.ref === "input") {
    return context.graph.input === "schema"
      ? null
      : { kind: "record" as const, fields: context.graph.input };
  }

  const node = context.nodes.get(ref.ref);

  if (node?.kind === "code" || node?.kind === "command") {
    return node.out;
  }

  return node?.kind === "wait" ? node.payload : null;
}

function recordPathType(schema: RecordSpec, path: string[]): string | null {
  if (path.length === 0) {
    return "object";
  }

  const field = path[0] ?? "";
  const optional = `${field}?`;

  const type = Object.hasOwn(schema, field)
    ? schema[field]
    : Object.hasOwn(schema, optional)
      ? schema[optional]
      : null;

  if (path.length !== 1) {
    return null;
  }

  return type ?? null;
}

function bodyResultType(
  context: Context,
  owner: Node,
  entry: NodeId,
  path: string[],
): string | null {
  const result = context.graph.nodes.find(
    (child) =>
      child.scope === owner.id &&
      (child.kind === "join" || child.kind === "fail") &&
      !context.graph.edges.some((edge) => edge.from === child.id && edge.kind === "next") &&
      scopeReaches(context, entry, child.id),
  );

  return resolveRefType(context, { ref: result?.id ?? entry, path });
}

function literalPathType(context: Context, value: Value, path: string[]): string | null {
  if (isRef(value)) {
    return resolveRefType(context, { ref: value.ref, path: [...value.path, ...path] });
  }

  if (path.length === 0) {
    return operandType(value, (ref) => resolveRefType(context, ref));
  }

  const [field, ...rest] = path;

  if (field === undefined || !isRecord(value) || !Object.hasOwn(value, field)) {
    return null;
  }

  return literalPathType(context, value[field] ?? null, rest);
}

function derivedType(context: Context, node: Node, path: string[]): string | null {
  switch (node.kind) {
    case "branch":
    case "switch":
    case "rescue": {
      const arms = targets(node)
        .map((entry) => bodyResultType(context, node, entry, path))
        .filter((type) => type !== "never");

      if (arms.length === 0) {
        return "never";
      }

      if (path.length > 0 && arms.some((type) => type === null)) {
        return null;
      }

      return arms.every((type) => type === arms[0]) ? (arms[0] ?? null) : "json";
    }

    case "parallel": {
      if (path.length === 0) {
        return "object";
      }

      const [label, ...rest] = path;

      const entry =
        label !== undefined && Object.hasOwn(node.branches, label)
          ? node.branches[label]
          : undefined;

      return entry === undefined ? null : bodyResultType(context, node, entry, rest);
    }

    case "join":
      return literalPathType(context, node.result, path);
    case "finally":
      return bodyResultType(context, node, node.body, path);
    case "map":
      return path.length === 0
        ? `${node.onError === "collect" ? "json" : (bodyResultType(context, node, node.body, []) ?? "json")}[]`
        : null;
    default:
      return null;
  }
}

function resolveRefType(context: Context, ref: { ref: string; path: string[] }): string | null {
  const key = JSON.stringify([ref.ref, ref.path]);

  if (context.refTypes.has(key)) {
    return context.refTypes.get(key) ?? null;
  }

  // Track ids because cyclic field projections can grow the path on each traversal.
  if (context.resolving.has(ref.ref)) {
    return null;
  }

  context.resolving.add(ref.ref);
  const type = declaredRefType(context, ref);
  context.resolving.delete(ref.ref);
  context.refTypes.set(key, type);

  return type;
}

function declaredRefType(context: Context, ref: { ref: string; path: string[] }): string | null {
  const node = context.nodes.get(ref.ref);
  const owner = binding(context, ref);

  if (node?.kind === "fail") {
    return "never";
  }

  if (owner?.kind === "map" && ref.ref !== "input") {
    const array = resolveRefType(context, owner.over);

    const type =
      owner.index === ref.ref ? "number" : array?.endsWith("[]") ? array.slice(0, -2) : "json";

    return ref.path.length === 0 ? (type ?? "json") : null;
  }

  if (owner?.kind === "rescue") {
    return recordPathType(ERROR_FIELDS, ref.path);
  }

  const schema = declaredSchema(context, ref);

  if (schema) {
    return schema.kind === "record"
      ? recordPathType(schema.fields, ref.path)
      : ref.path.length === 0
        ? schema.type
        : null;
  }

  if (
    node &&
    ["branch", "switch", "rescue", "join", "finally", "map", "parallel"].includes(node.kind)
  ) {
    return derivedType(context, node, ref.path);
  }

  return ref.path.length === 0 ? scalarNodeType(node) : null;
}

function scalarNodeType(node: Node | undefined): string | null {
  if (node?.kind === "format" || node?.kind === "now" || node?.kind === "uuid") {
    return "string";
  }

  if (node?.kind === "random") {
    return "number";
  }

  if (node?.kind === "log" || node?.kind === "sleep") {
    return "null";
  }

  return null;
}

export function graphTypeResolver(graph: Pick<Graph, "input" | "nodes" | "edges">) {
  const context: Context = {
    graph,
    nodes: new Map(graph.nodes.map((node) => [node.id, node])),
    refTypes: new Map(),
    resolving: new Set(),
  };

  return (ref: { ref: string; path: string[] }) => resolveRefType(context, ref);
}
