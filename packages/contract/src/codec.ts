import { Effect, Schema, SchemaGetter } from "effect";

export const boundaryOptions = { onExcessProperty: "error" } as const;

export const decodeBoundary = <S extends Schema.ConstraintDecoder<unknown>>(schema: S) =>
  Schema.decodeUnknownSync(schema, boundaryOptions);

export const encodeBoundary = <S extends Schema.ConstraintEncoder<unknown>>(schema: S) =>
  Schema.encodeUnknownSync(schema, boundaryOptions);

export const decodeJson = <S extends Schema.ConstraintDecoder<unknown>>(schema: S) =>
  Schema.decodeUnknownSync(Schema.fromJsonString(schema), boundaryOptions);

export const queryNumber = Schema.Unknown.pipe(
  Schema.decodeTo(Schema.Finite, {
    decode: SchemaGetter.transform(Number),
    encode: SchemaGetter.transform((value) => value),
  }),
);

export const queryCounter = queryNumber
  .check(Schema.isInt())
  .check(Schema.isGreaterThanOrEqualTo(0));

export const MAX_PAGE_LIMIT = 200;

export const pageLimit = (fallback: number) =>
  queryNumber
    .check(Schema.isInt())
    .check(Schema.isGreaterThan(0))
    .check(Schema.isLessThanOrEqualTo(MAX_PAGE_LIMIT))
    .pipe(Schema.withDecodingDefault(Effect.succeed(fallback)));

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

export const boundedToken = Schema.String.check(Schema.isMinLength(1)).check(
  Schema.isMaxLength(256),
);

export const base64Text = Schema.String.check(
  Schema.isPattern(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
);

/** Base64 text whose decoded size stays within maxBytes. */
export const boundedBase64 = (maxBytes: number) =>
  base64Text.check(Schema.isMaxLength(Math.ceil(maxBytes / 3) * 4));
