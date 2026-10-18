import { recordField } from "./field-value.js";
import {
  ERROR_FIELDS,
  type Node,
  type NodeId,
  type OutSchema,
  type RecordSpec,
  type Ref,
  type Value,
  type ValueType,
} from "./graph.js";
import {
  binding,
  createContext,
  type Context as GraphContext,
  isTail,
  scopeReaches,
  targets,
} from "./graph-context.js";
import { arrayType, elementType, operandType } from "./graph-predicate.js";
import { isRef, projectValue } from "./graph-values.js";

type Context = GraphContext & { refTypes: Map<string, ValueType | null>; resolving: Set<string> };

function recordPathType(schema: RecordSpec, path: string[]): ValueType | null {
  if (path.length === 0) {
    return "object";
  }

  const [key] = path;

  return path.length === 1 && key !== undefined ? (recordField(schema, key)?.type ?? null) : null;
}

function schemaType(schema: OutSchema, path: string[]): ValueType | null {
  if (schema === null) {
    return path.length === 0 ? "null" : null;
  }

  if (schema.kind === "record") {
    return recordPathType(schema.fields, path);
  }

  return path.length === 0 ? schema.type : null;
}

function bodyResultType(
  context: Context,
  owner: Node,
  entry: NodeId,
  path: string[],
): ValueType | null {
  const result = context.graph.nodes.find(
    (child) =>
      child.scope === owner.id &&
      (child.kind === "join" || child.kind === "fail") &&
      isTail(context, child) &&
      scopeReaches(context, entry, child.id),
  );

  const node = result ?? context.nodes.get(entry);

  return node ? nodeType(context, node, path) : null;
}

function literalPathType(context: Context, value: Value, path: string[]): ValueType | null {
  if (isRef(value)) {
    return resolveRefType(context, { ref: value.ref, path: [...value.path, ...path] });
  }

  if (path.length === 0) {
    return operandType(value, (ref) => resolveRefType(context, ref));
  }

  const [field, ...rest] = path;
  const member = field === undefined ? undefined : projectValue(value, [field]);

  return member === undefined ? null : literalPathType(context, member, rest);
}

function parallelType(
  context: Context,
  node: Extract<Node, { kind: "parallel" }>,
  path: string[],
): ValueType | null {
  const entries = Object.values(node.branches);

  if (entries.some((entry) => bodyResultType(context, node, entry, []) === "never")) {
    return "never";
  }

  if (path.length === 0) {
    return "object";
  }

  const [label, ...rest] = path;

  const entry =
    label !== undefined && Object.hasOwn(node.branches, label) ? node.branches[label] : undefined;

  return entry === undefined ? null : bodyResultType(context, node, entry, rest);
}

function assertNever(node: never): never {
  throw new Error(`Unknown node kind: ${JSON.stringify(node)}`);
}

function commonArmType(context: Context, node: Node, path: string[]): ValueType | null {
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

function nodeType(context: Context, node: Node, path: string[]): ValueType | null {
  switch (node.kind) {
    case "code":
    case "command":
      return schemaType(node.out, path);
    case "wait":
      return schemaType(node.payload, path);
    case "branch":
    case "switch":
    case "rescue":
      return commonArmType(context, node, path);

    case "parallel":
      return parallelType(context, node, path);
    case "join":
      if (node.result.kind === "none") {
        return "never";
      }

      return literalPathType(context, node.result.value, path);
    case "finally":
      return bodyResultType(context, node, node.body, path);
    case "map": {
      if (path.length !== 0) {
        return null;
      }

      const body = bodyResultType(context, node, node.body, []);

      if (body === "never") {
        return "never";
      }

      return node.onError === "collect" ? "json[]" : arrayType(body);
    }

    case "fail":
      return "never";
    case "format":
    case "now":
    case "uuid":
      return path.length === 0 ? "string" : null;
    case "random":
      return path.length === 0 ? "number" : null;
    case "log":
    case "sleep":
      return path.length === 0 ? "null" : null;
    default:
      return assertNever(node);
  }
}

function declaredRefType(context: Context, ref: Ref): ValueType | null {
  const owner = binding(context, ref.ref);

  if (owner?.kind === "map") {
    if (ref.path.length !== 0) {
      return null;
    }

    if (owner.index === ref.ref) {
      return "number";
    }

    return elementType(resolveRefType(context, owner.over));
  }

  if (owner?.kind === "rescue") {
    return recordPathType(ERROR_FIELDS, ref.path);
  }

  if (ref.ref === "input") {
    return recordPathType(context.graph.input, ref.path);
  }

  const node = context.nodes.get(ref.ref);

  return node ? nodeType(context, node, ref.path) : null;
}

function resolveRefType(context: Context, ref: Ref): ValueType | null {
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

export function graphTypeResolver(graph: GraphContext["graph"], topology = createContext(graph)) {
  const context: Context = { ...topology, refTypes: new Map(), resolving: new Set() };

  return (ref: Ref) => resolveRefType(context, ref);
}
