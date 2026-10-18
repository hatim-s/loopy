import type { FieldType, RecordSpec } from "./graph.js";
import { isJson } from "./json.js";
import type { Json } from "./model.js";
import { isBoolean, isNumber, isRecord, isString } from "./validation.js";

export function recordFields(spec: RecordSpec) {
  return Object.entries(spec).map(([field, type]) => ({
    key: field.replace(/\?$/, ""),
    type,
    optional: field.endsWith("?"),
  }));
}

export function recordField(spec: RecordSpec, key: string) {
  if (Object.hasOwn(spec, key)) {
    const type = spec[key];

    return type === undefined ? undefined : { key, type, optional: false };
  }

  const type = Object.hasOwn(spec, `${key}?`) ? spec[`${key}?`] : undefined;

  return type === undefined ? undefined : { key, type, optional: true };
}

export function matchesRecord(
  spec: RecordSpec,
  value: unknown,
  { extraKeys }: { extraKeys: "reject" | "allow" },
): value is Record<string, Json> {
  if (!isRecord(value) || !isJson(value)) {
    return false;
  }

  const fields = recordFields(spec);

  if (
    extraKeys === "reject" &&
    Object.keys(value).some((key) => !fields.some((field) => field.key === key))
  ) {
    return false;
  }

  return fields.every(
    ({ key, type, optional }) =>
      (optional && !Object.hasOwn(value, key)) ||
      (Object.hasOwn(value, key) && isFieldValue(type, value[key])),
  );
}

export function isFieldValue(kind: FieldType, value: unknown): value is Json {
  switch (kind) {
    case "string":
    case "boolean":
      return typeof value === kind;
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "json":
      return isJson(value);
    case "string[]":
      return Array.isArray(value) && value.every(isString) && isJson(value);
    case "number[]":
      return (
        Array.isArray(value) &&
        value.every((item) => isNumber(item) && Number.isFinite(item)) &&
        isJson(value)
      );
    case "boolean[]":
      return Array.isArray(value) && value.every(isBoolean) && isJson(value);
    case "json[]":
      return Array.isArray(value) && isJson(value);
  }
}

export type Field = {
  string: string;
  number: number;
  boolean: boolean;
  json: Json;
  "string[]": string[];
  "number[]": number[];
  "boolean[]": boolean[];
  "json[]": Json[];
};

type ObjectOf<S extends RecordSpec> = {
  -readonly [K in keyof S as K extends `${string}?` ? never : K]: Field[S[K]];
} & {
  -readonly [K in keyof S as K extends `${infer Name}?` ? Name : never]?: Field[S[K]];
};

export type InferRecord<S extends RecordSpec> = { [K in keyof ObjectOf<S>]: ObjectOf<S>[K] };
