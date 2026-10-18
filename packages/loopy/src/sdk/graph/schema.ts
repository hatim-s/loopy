import {
  FIELD_TYPES,
  type FieldType,
  isString,
  type OutSchema,
  type RecordSpec,
  requireOneOf,
  requireRecord,
} from "../../core/index.js";
import { parseDefinitionInput } from "./definition.js";

export type Output = OutSchema | RecordSpec | FieldType | undefined;

export type Normalized<S extends Output> = S extends null | undefined
  ? null
  : S extends OutSchema
    ? S
    : S extends FieldType
      ? { kind: "value"; type: S }
      : S extends RecordSpec
        ? { kind: "record"; fields: S }
        : never;

export function normalizeOut<const S extends Output>(value: S): Normalized<S>;
export function normalizeOut(value: Output): OutSchema {
  if (value === undefined || value === null) {
    return null;
  }

  if (isString(value)) {
    return { kind: "value", type: requireOneOf(value, FIELD_TYPES, "Output type") };
  }

  const record = requireRecord(value, "Output schema");

  if (record.kind === "record") {
    return { kind: "record", fields: parseDefinitionInput(record.fields) };
  }

  if (record.kind === "value") {
    return { kind: "value", type: requireOneOf(record.type, FIELD_TYPES, "Output type") };
  }

  return { kind: "record", fields: parseDefinitionInput(record) };
}
