import { Effect, Schema, SchemaGetter } from "effect";
import { PAGE_LIMIT } from "./dashboard-reader";

export const boundaryOptions = { onExcessProperty: "error" } as const;

export const decodeBoundary = <S extends Schema.ConstraintDecoder<unknown>>(schema: S) =>
  Schema.decodeUnknownSync(schema, boundaryOptions);

export const encodeBoundary = <S extends Schema.ConstraintEncoder<unknown>>(schema: S) =>
  Schema.encodeUnknownSync(schema, boundaryOptions);

export const decodeJson = <S extends Schema.ConstraintDecoder<unknown>>(schema: S) =>
  Schema.decodeUnknownSync(Schema.fromJsonString(schema), boundaryOptions);

// URL search values arrive as text; typed callers pass numbers.
export const queryNumber = Schema.Union([Schema.String, Schema.Finite]).pipe(
  Schema.decodeTo(Schema.Finite, {
    decode: SchemaGetter.transform(Number),
    encode: SchemaGetter.transform((value) => value),
  }),
);

export const queryCounter = queryNumber
  .check(Schema.isInt())
  .check(Schema.isGreaterThanOrEqualTo(0));

export const pageLimit = (fallback: number) =>
  queryNumber
    .check(Schema.isInt())
    .check(Schema.isGreaterThan(0))
    .check(Schema.isLessThanOrEqualTo(PAGE_LIMIT))
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

// Web Crypto digests need bytes backed by a plain ArrayBuffer.
const bufferBytes = Schema.declare(
  (value): value is Uint8Array<ArrayBuffer> =>
    value instanceof Uint8Array && value.buffer instanceof ArrayBuffer,
);

/** Bytes on the wire as canonical base64, so callers pass the compiler's Uint8Array directly. */
export const base64Bytes = base64Text.pipe(
  Schema.decodeTo(bufferBytes, {
    decode: SchemaGetter.transform((text) =>
      Uint8Array.from(atob(text), (char) => char.charCodeAt(0)),
    ),
    encode: SchemaGetter.transform((bytes) =>
      btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join("")),
    ),
  }),
);
