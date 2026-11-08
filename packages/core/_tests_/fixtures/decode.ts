import { Schema } from "effect";

/** Strict decoding, as the HTTP and file boundaries apply it to these schemas. */
export const decode = <S extends Schema.ConstraintDecoder<unknown>>(schema: S) =>
  Schema.decodeUnknownSync(schema, { onExcessProperty: "error" });
