import type { Node, Ref, Value } from "./graph.js";
import { predicateValues } from "./graph-predicate.js";
import type { Json } from "./model.js";
import { isRecord } from "./validation.js";

export function isRef(value: Value): value is Ref {
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

export function projectValue(value: Json | undefined, path: readonly string[]): Json | undefined {
  return path.reduce<Json | undefined>(
    (item, key) => (isRecord(item) && Object.hasOwn(item, key) ? item[key] : undefined),
    value,
  );
}

export function refs(value: Value): Ref[] {
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

export function values(node: Node): Value[] {
  switch (node.kind) {
    case "code":
      return Object.values(node.in);
    case "command":
      return [
        ...node.argv,
        ...Object.values(node.parse?.input ?? {}),
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
      return node.result.kind === "none" ? [] : [node.result.value];
    default:
      return [];
  }
}
