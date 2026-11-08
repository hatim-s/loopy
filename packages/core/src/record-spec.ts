import { MAX_OUTPUT_BYTES, outputBytes } from "./effects";
import type { FieldType, OutSchema, RecordSpec } from "./graph/values";
import type { Json } from "./json";
import { isBoolean, isNumber, isRecord, isString } from "./validation";

// A trailing "?" marks an optional record field; values use the key without it.
export function fieldKey(field: string): string {
  return field.endsWith("?") ? field.slice(0, -1) : field;
}

export type RecordField = { key: string; optional: boolean; kind: FieldType };

export function recordFields(spec: RecordSpec): RecordField[] {
  return Object.entries(spec).map(([field, kind]) => ({
    key: fieldKey(field),
    optional: field.endsWith("?"),
    kind,
  }));
}

export function recordField(spec: RecordSpec, key: string): FieldType | undefined {
  return recordFields(spec).find((field) => field.key === key)?.kind;
}

const isFiniteNumber = (value: Json) => isNumber(value) && Number.isFinite(value);

export function isFieldValue(kind: FieldType, value: Json | undefined): boolean {
  switch (kind) {
    case "string":
      return isString(value);
    case "number":
      return value !== undefined && isFiniteNumber(value);
    case "boolean":
      return isBoolean(value);
    case "json":
      return value !== undefined;
    case "string[]":
      return Array.isArray(value) && value.every(isString);
    case "number[]":
      return Array.isArray(value) && value.every(isFiniteNumber);
    case "boolean[]":
      return Array.isArray(value) && value.every(isBoolean);
    case "json[]":
      return Array.isArray(value);
  }
}

export function matchesRecordSpec(value: Json, spec: RecordSpec): boolean {
  return (
    isRecord(value) &&
    recordFields(spec).every(
      ({ key, optional, kind }) =>
        (optional && value[key] === undefined) || isFieldValue(kind, value[key]),
    )
  );
}

export function exceedsInlineLimit(value: Json): boolean {
  return outputBytes(value) > MAX_OUTPUT_BYTES;
}

export type OutSchemaIssue = "output_limit" | "mismatch";

/** Node outputs and wait payloads share the inline cap and the declared out-schema rule. */
export function checkOutSchema(value: Json, schema: OutSchema): OutSchemaIssue | null {
  if (exceedsInlineLimit(value)) {
    return "output_limit";
  }

  const valid =
    schema.kind === "value"
      ? isFieldValue(schema.type, value)
      : matchesRecordSpec(value, schema.fields);

  return valid ? null : "mismatch";
}

const OUT_SCHEMA_MESSAGES = {
  output_limit: "exceeds the 1 MiB inline limit.",
  mismatch: "does not match its declared schema.",
} satisfies Record<OutSchemaIssue, string>;

export function outSchemaMessage(subject: string, issue: OutSchemaIssue): string {
  return `${subject} ${OUT_SCHEMA_MESSAGES[issue]}`;
}

export type FieldText = { ok: true; value: Json } | { ok: false; reason: "json" | "kind" };

/** Turns one CLI argument or form control into a field value. Callers word the failure. */
export function parseFieldText(kind: FieldType, text: string): FieldText {
  switch (kind) {
    case "string":
      return { ok: true, value: text };
    case "number":
      return text.trim() !== "" && Number.isFinite(Number(text))
        ? { ok: true, value: Number(text) }
        : { ok: false, reason: "kind" };
    case "boolean":
      return text === "true" || text === "false"
        ? { ok: true, value: text === "true" }
        : { ok: false, reason: "kind" };
    default: {
      let value: Json;

      try {
        value = JSON.parse(text);
      } catch {
        return { ok: false, reason: "json" };
      }

      return isFieldValue(kind, value) ? { ok: true, value } : { ok: false, reason: "kind" };
    }
  }
}
