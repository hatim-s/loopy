import { isRecord } from "../validation";
import { values } from "./context";
import { declaredOutput, type Node } from "./nodes";
import type { Value } from "./values";

function valueNames(value: Value): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(valueNames);
  }

  return isRecord(value)
    ? Object.entries(value).flatMap(([key, child]) => [key, ...valueNames(child)])
    : [];
}

export function nodeNames(node: Node): string[] {
  const schema = declaredOutput(node);

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
