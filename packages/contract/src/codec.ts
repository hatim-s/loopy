import { Schema, SchemaGetter, Struct } from "effect";

/** Every wire edge rejects undeclared fields, including nested structs. */

export const boundaryOptions = { onExcessProperty: "error" } as const;

export const decodeBoundary = <S extends Schema.ConstraintDecoder<unknown>>(schema: S) =>
  Schema.decodeUnknownSync(schema, boundaryOptions);

export const encodeBoundary = <S extends Schema.ConstraintEncoder<unknown>>(schema: S) =>
  Schema.encodeUnknownSync(schema, boundaryOptions);

// Preserve Number coercion, including whitespace, null and booleans, at query edges.
export const queryNumber = Schema.Unknown.pipe(
  Schema.decodeTo(Schema.Finite, {
    decode: SchemaGetter.transform(Number),
    encode: SchemaGetter.transform((value) => value),
  }),
);

export const isoDateTime = Schema.String.check(
  Schema.makeFilter(
    (value) => {
      if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)) {
        return false;
      }

      const date = new Date(value);

      return Number.isFinite(date.getTime()) && date.toISOString() === value;
    },
    { message: "Supply an ISO UTC timestamp with millisecond precision." },
  ),
);

/** Preserve mutable wire records while returning a native Effect Struct. */
export const struct = <const F extends Schema.Struct.Fields>(fields: F) =>
  Schema.Struct(fields).mapFields(Struct.map(Schema.mutableKey));
