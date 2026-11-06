import type { Json } from "../model";
import { isRecord } from "../validation";
import type { Ref, Value } from ".";

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
