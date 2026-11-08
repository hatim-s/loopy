import { recordField } from "../record-spec";
import type { Graph } from ".";
import {
  binding,
  type Context as GraphContext,
  isBodyTail,
  scopeReaches,
  targets,
} from "./context";
import { declaredOutput, type Node } from "./nodes";
import { operandType } from "./predicate";
import { isRef, projectValue } from "./ref";
import {
  arrayType,
  ERROR_FIELDS,
  elementType,
  type GraphType,
  INPUT_REF,
  type NodeId,
  type OutSchema,
  type RecordSpec,
  type RefLookup,
  type Value,
} from "./values";

type Context = GraphContext & {
  refTypes: Map<string, GraphType | null>;
  resolving: Set<string>;
};

function recordPathType(schema: RecordSpec, path: string[]): GraphType | null {
  if (path.length === 0) {
    return "object";
  }

  const [key] = path;

  return path.length === 1 && key !== undefined ? (recordField(schema, key) ?? null) : null;
}

function outputPathType(schema: OutSchema | null, path: string[]): GraphType | null {
  if (schema === null) {
    return null;
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
): GraphType | null {
  const result = context.graph.nodes.find(
    (child) =>
      child.scope === owner.id &&
      (child.kind === "join" || child.kind === "fail") &&
      isBodyTail(context, child) &&
      scopeReaches(context, entry, child.id),
  );

  return resolveRefType(context, { ref: result?.id ?? entry, path });
}

function literalPathType(context: Context, value: Value, path: string[]): GraphType | null {
  if (isRef(value)) {
    return resolveRefType(context, { ref: value.ref, path: [...value.path, ...path] });
  }

  if (path.length === 0) {
    return operandType(value, (ref) => resolveRefType(context, ref));
  }

  const [field, ...rest] = path;

  const member = field === undefined ? undefined : projectValue(value, [field]);

  if (member === undefined) {
    return null;
  }

  return literalPathType(context, member, rest);
}

function armsType(context: Context, node: Node, path: string[]): GraphType | null {
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

function parallelType(
  context: Context,
  node: Extract<Node, { kind: "parallel" }>,
  path: string[],
): GraphType | null {
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

function scalar(type: GraphType, path: string[]): GraphType | null {
  return path.length === 0 ? type : null;
}

function nodeType(context: Context, node: Node, path: string[]): GraphType | null {
  switch (node.kind) {
    case "code":
    case "command":
    case "wait":
      return outputPathType(declaredOutput(node), path);
    case "branch":
    case "switch":
    case "rescue":
      return armsType(context, node, path);
    case "parallel":
      return parallelType(context, node, path);
    case "join":
      return node.result.kind === "none"
        ? "never"
        : literalPathType(context, node.result.value, path);
    case "finally":
      return bodyResultType(context, node, node.body, path);
    case "map":
      return scalar(
        arrayType(
          node.onError === "collect" ? "json" : bodyResultType(context, node, node.body, []),
        ),
        path,
      );
    case "format":
    case "now":
    case "uuid":
      return scalar("string", path);
    case "random":
      return scalar("number", path);
    case "log":
    case "sleep":
      return scalar("null", path);
    case "fail":
      return "never";
  }
}

function resolveRefType(context: Context, ref: RefLookup): GraphType | null {
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

function declaredRefType(context: Context, ref: RefLookup): GraphType | null {
  const node = context.nodes.get(ref.ref);
  const owner = binding(context, ref);

  if (node?.kind === "fail") {
    return "never";
  }

  // A binding named like the input ref is reported as duplicate_ref; it must not also retype input.
  if (owner?.kind === "map" && ref.ref !== INPUT_REF) {
    const item =
      owner.index === ref.ref ? "number" : elementType(resolveRefType(context, owner.over));

    return scalar(item ?? "json", ref.path);
  }

  if (owner?.kind === "rescue") {
    return recordPathType(ERROR_FIELDS, ref.path);
  }

  if (ref.ref === INPUT_REF) {
    return context.graph.input === "schema" ? null : recordPathType(context.graph.input, ref.path);
  }

  return node === undefined ? null : nodeType(context, node, ref.path);
}

export function graphTypeResolver(graph: Pick<Graph, "input" | "nodes" | "edges">) {
  const context: Context = {
    graph,
    nodes: new Map(graph.nodes.map((node) => [node.id, node])),
    refTypes: new Map(),
    resolving: new Set(),
  };

  return (ref: RefLookup) => resolveRefType(context, ref);
}
