import type { Node, Value } from "./graph.js";
import { values } from "./graph-context.js";
import { isRecord } from "./validation.js";

export function isReservedGraphName(name: string): boolean {
  return ["__proto__", "constructor", "prototype"].includes(name.replace(/\?$/, ""));
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
