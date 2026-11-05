import { Schema } from "effect";
import {
  COMPARISON_OPS,
  type Duration,
  FIELD_TYPES,
  isReservedGraphName,
  type Json,
  type NodeId,
  PREDICATE_OPS,
  type Predicate,
  type RefId,
} from "../core/index.js";
import { struct } from "./codec.js";

// BOUNDARY: Graph ids are branded only after the wire has supplied nonempty strings.
export const nodeIdSchema = Schema.declare<NodeId>(
  (value): value is NodeId => typeof value === "string" && value.length > 0,
);

// BOUNDARY: Reference ids use their own brand at the graph boundary.
export const refIdSchema = Schema.declare<RefId>(
  (value): value is RefId => typeof value === "string" && value.length > 0,
);

export const labelSchema = Schema.String.check(
  Schema.makeFilter((name) => !isReservedGraphName(name), {
    message: "Reserved graph names cannot be labels or record keys.",
  }),
);

export const refSchema = struct({
  ref: refIdSchema,
  path: Schema.Array(Schema.String).pipe(Schema.mutable),
});

// Check raw keys before parsing so reserved own keys cannot disappear in a decoder.
export function graphRecord<T extends Schema.Constraint>(schema: T) {
  return Schema.Record(Schema.String, schema).check(
    Schema.makeFilter((value) => Object.keys(value).every((name) => !isReservedGraphName(name)), {
      message: "Reserved graph names cannot be record keys.",
    }),
  );
}

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

export const outputSchema = Schema.Union([
  struct({ kind: Schema.Literal("record"), fields: graphRecord(Schema.Literals(FIELD_TYPES)) }),
  struct({ kind: Schema.Literal("value"), type: Schema.Literals(FIELD_TYPES) }),
]);

const operandSchema = Schema.Union([
  struct({ ...refSchema.fields, size: Schema.Literal(true) }),
  valueSchema,
]);

export const predicateSchema: Schema.Codec<Predicate> = Schema.Union([
  struct({ op: Schema.Literals(COMPARISON_OPS), left: operandSchema, right: operandSchema }),
  struct({ op: Schema.Literals([PREDICATE_OPS[6], PREDICATE_OPS[7]]), value: valueSchema }),
  struct({
    op: Schema.Literals([PREDICATE_OPS[9], PREDICATE_OPS[10]]),
    get predicates() {
      return Schema.Array(Schema.suspend(() => predicateSchema)).pipe(Schema.mutable);
    },
  }),
  struct({
    op: Schema.Literal(PREDICATE_OPS[11]),
    get predicate() {
      return Schema.suspend(() => predicateSchema);
    },
  }),
]);

// BOUNDARY: Durations arrive as JSON numbers or unit-suffixed strings.
export const durationSchema = Schema.declare<Duration>((value): value is Duration =>
  typeof value === "number"
    ? Number.isFinite(value) && value >= 0
    : typeof value === "string" && /^\d+(?:\.\d+)?[smhd]$/.test(value),
);
