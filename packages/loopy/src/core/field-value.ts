import type { RecordSpec } from "./graph.js";
import type { Json } from "./model.js";
import { isBoolean, isNumber, isRecord, isString } from "./validation.js";

// BOUNDARY: Record inputs may contain arbitrary external JSON, but not host values.
function isJson(value: unknown): value is Json {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return true;
  }

  if (typeof value === "number") {
    return Number.isFinite(value);
  }

  if (Array.isArray(value)) {
    return value.every(isJson);
  }

  return (
    isRecord(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
    Object.values(value).every(isJson)
  );
}

export function isFieldValue(kind: RecordSpec[string], value: unknown): value is Json {
  switch (kind) {
    case "string":
    case "boolean":
      return typeof value === kind;
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "json":
      return isJson(value);
    case "string[]":
      return Array.isArray(value) && value.every(isString);
    case "number[]":
      return Array.isArray(value) && value.every((item) => isNumber(item) && Number.isFinite(item));
    case "boolean[]":
      return Array.isArray(value) && value.every(isBoolean);
    case "json[]":
      return Array.isArray(value) && value.every(isJson);
  }
}
