import { Effect, Schema, SchemaGetter } from "effect";
import { PAGE_LIMIT } from "./limits";

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

export const queryPositiveInt = queryNumber.check(Schema.isInt()).check(Schema.isGreaterThan(0));

export const pageLimit = (fallback: number) =>
  queryPositiveInt
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

/** The longest base64 text whose decoded bytes can fit within maxBytes. */
export const base64Length = (maxBytes: number) => Math.ceil(maxBytes / 3) * 4;

export const base64Decode = (text: string) =>
  Uint8Array.from(atob(text), (char) => char.charCodeAt(0));

/** Chunked, because spreading a multi-megabyte bundle into one call overflows the stack. */
export function base64Encode(bytes: Uint8Array): string {
  let binary = "";

  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }

  return btoa(binary);
}

/** Base64 text whose decoded size stays within maxBytes. */
export const boundedBase64 = (maxBytes: number) =>
  base64Text.check(Schema.isMaxLength(base64Length(maxBytes)));

// Web Crypto digests need bytes backed by a plain ArrayBuffer.
const bufferBytes = Schema.declare(
  (value): value is Uint8Array<ArrayBuffer> =>
    value instanceof Uint8Array && value.buffer instanceof ArrayBuffer,
);

/** Bytes on the wire as canonical base64, so callers pass the compiler's Uint8Array directly. */
export const base64Bytes = base64Text.pipe(
  Schema.decodeTo(bufferBytes, {
    decode: SchemaGetter.transform(base64Decode),
    encode: SchemaGetter.transform(base64Encode),
  }),
);
