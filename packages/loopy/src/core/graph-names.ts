import { recordFields } from "./field-value.js";
import type { Node, OutSchema, Value } from "./graph.js";
import { values } from "./graph-values.js";
import { isRecord } from "./validation.js";

export const RESERVED_GRAPH_NAMES = ["__proto__", "constructor", "prototype"] as const;

export function isReservedGraphName(name: string): boolean {
  const [field] = recordFields({ [name]: "json" });
  return RESERVED_GRAPH_NAMES.some((reserved) => reserved === field?.key);
}

function valueNames(value: Value): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(valueNames);
  }

  return isRecord(value)
    ? Object.entries(value).flatMap(([key, child]) => [key, ...valueNames(child)])
    : [];
}

export function nodeNames(node: Node): string[] {
  const schema = nodeSchema(node);

  return [
    ...(node.label === null ? [] : [node.label]),
    ...(schema?.kind === "record" ? Object.keys(schema.fields) : []),
    ...(node.kind === "switch" ? Object.keys(node.cases) : []),
    ...(node.kind === "parallel" ? Object.keys(node.branches) : []),
    ...(node.kind === "code" ? Object.keys(node.in) : []),
    ...(node.kind === "command"
      ? [...Object.keys(node.flags), ...Object.keys(node.options.env)]
      : []),
    ...(node.kind === "format" ? Object.keys(node.values) : []),
    ...values(node).flatMap(valueNames),
  ];
}

function nodeSchema(node: Node): OutSchema | null {
  switch (node.kind) {
    case "code":
    case "command":
      return node.out;
    case "wait":
      return node.payload;
    default:
      return null;
  }
}
