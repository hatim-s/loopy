import type { Node, Value } from "./graph.js";
import { values } from "./graph-ref.js";
import { isRecord } from "./validation.js";

export const RESERVED_GRAPH_NAMES = ["__proto__", "constructor", "prototype"] as const;

export function isReservedGraphName(name: string): boolean {
  return RESERVED_GRAPH_NAMES.some((reserved) => reserved === name.replace(/\?$/, ""));
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
  const schema =
    node.kind === "code" || node.kind === "command"
      ? node.out
      : node.kind === "wait"
        ? node.payload
        : null;

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
