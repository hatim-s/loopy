import { Schema } from "effect";
import { struct } from "../codec";
import type { Json } from "../json";
import { fieldKey } from "../record-spec";
import { isString } from "../validation";

declare const brand: unique symbol;

type Brand<T, Name extends string> = T & { readonly [brand]: Name };

export type NodeId = Brand<string, "NodeId">;

export type RefId = Brand<string, "RefId">;

// The compiler reserves 'input' as the graph's external-input binding.
export const INPUT_REF = "input";

// BOUNDARY: Graph ids are branded only after the wire has supplied nonempty strings.
export const nodeIdSchema = Schema.declare<NodeId>(
  (value): value is NodeId => isString(value) && value.length > 0,
);

// BOUNDARY: Reference ids use their own brand at the graph boundary.
export const refIdSchema = Schema.declare<RefId>(
  (value): value is RefId => isString(value) && value.length > 0,
);

const RESERVED_GRAPH_NAMES = ["__proto__", "constructor", "prototype"] as const;

export function isReservedGraphName(name: string): boolean {
  return RESERVED_GRAPH_NAMES.some((reserved) => reserved === fieldKey(name));
}

export const labelSchema = Schema.String.check(
  Schema.makeFilter((name) => !isReservedGraphName(name), {
    message: "Reserved graph names cannot be labels or record keys.",
  }),
);

export const FIELD_TYPES = [
  "string",
  "number",
  "boolean",
  "json",
  "string[]",
  "number[]",
  "boolean[]",
  "json[]",
] as const;

export type FieldType = (typeof FIELD_TYPES)[number];

const BASE_TYPES = ["string", "number", "boolean", "json", "object", "null", "never"] as const;

type BaseType = (typeof BASE_TYPES)[number];

// Field types are declared; object, null and never are derived from node kinds and literals.
export type GraphType = BaseType | `${BaseType}[]`;

export function elementType(type: GraphType | null): BaseType | null {
  return BASE_TYPES.find((base) => type === `${base}[]`) ?? null;
}

// Nested arrays have no declared type, so their elements read as JSON.
export function arrayType(element: GraphType | null): GraphType {
  const base = BASE_TYPES.find((candidate) => candidate === element);

  return base === undefined ? "json[]" : `${base}[]`;
}

export function isScalarType(type: GraphType | null): type is "string" | "number" | "boolean" {
  return type === "string" || type === "number" || type === "boolean";
}

export const refSchema = struct({
  ref: refIdSchema,
  path: Schema.Array(Schema.String).pipe(Schema.mutable),
});

export type Ref = Schema.Schema.Type<typeof refSchema>;

// A lookup may name an unbranded id from author code before it resolves to a node or binding.
export type RefLookup = { ref: string; path: string[] };

// Check raw keys before parsing so reserved own keys cannot disappear in a decoder.
export function graphRecord<T extends Schema.Constraint>(schema: T) {
  return Schema.Record(Schema.String, schema).check(
    Schema.makeFilter((value) => Object.keys(value).every((name) => !isReservedGraphName(name)), {
      message: "Reserved graph names cannot be record keys.",
    }),
  );
}

export const recordSpecSchema = graphRecord(Schema.Literals(FIELD_TYPES));

export type RecordSpec = Schema.Schema.Type<typeof recordSpecSchema>;

export const ERROR_FIELDS = {
  message: "string",
  code: "string",
  data: "json",
} as const satisfies RecordSpec;

export const outputSchema = Schema.Union([
  struct({ kind: Schema.Literal("record"), fields: recordSpecSchema }),
  struct({ kind: Schema.Literal("value"), type: Schema.Literals(FIELD_TYPES) }),
]);

export type OutSchema = Schema.Schema.Type<typeof outputSchema>;

// 'ref' is reserved in object values so malformed references cannot pass as JSON literals.
const literalSchema: Schema.Codec<Json> = Schema.suspend(() =>
  Schema.Union([
    Schema.Null,
    Schema.Boolean,
    Schema.Finite,
    Schema.String,
    refSchema,
    Schema.Array(literalSchema).pipe(Schema.mutable),
    graphRecord(Schema.mutableKey(literalSchema)).check(
      Schema.makeFilter((value) => !Object.hasOwn(value, "ref"), {
        message: "Supply a reference with a nonempty ref and a string path array.",
      }),
    ),
  ]),
);

export const valueSchema = Schema.Union([refSchema, literalSchema]);

export type Value = Schema.Schema.Type<typeof valueSchema>;

export const formatOperandSchema = Schema.Union([
  Schema.String,
  Schema.Finite,
  Schema.Boolean,
  refSchema,
]);

const sizeOperandSchema = struct({ ...refSchema.fields, size: Schema.Literal(true) });

const operandSchema = Schema.Union([sizeOperandSchema, valueSchema]);

export type ComparisonOperand = Schema.Schema.Type<typeof operandSchema>;

export const COMPARISON_OPS = ["eq", "ne", "lt", "lte", "gt", "gte", "in"] as const;

// Recursive schemas need a declared type for the compiler to close the cycle.
export type Predicate =
  | {
      op: (typeof COMPARISON_OPS)[number];
      left: ComparisonOperand;
      right: ComparisonOperand;
    }
  | { op: "exists" | "isNull"; value: Value }
  | { op: "and" | "or"; predicates: Predicate[] }
  | { op: "not"; predicate: Predicate };

export const predicateSchema: Schema.Codec<Predicate> = Schema.Union([
  struct({ op: Schema.Literals(COMPARISON_OPS), left: operandSchema, right: operandSchema }),
  struct({ op: Schema.Literals(["exists", "isNull"]), value: valueSchema }),
  struct({
    op: Schema.Literals(["and", "or"]),
    get predicates() {
      return Schema.Array(Schema.suspend(() => predicateSchema)).pipe(Schema.mutable);
    },
  }),
  struct({
    op: Schema.Literal("not"),
    get predicate() {
      return Schema.suspend(() => predicateSchema);
    },
  }),
]);
