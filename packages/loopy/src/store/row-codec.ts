import { flow, Result, Schema, SchemaIssue } from "effect";
import { StoredDataError } from "./operation.js";

const formatIssue = SchemaIssue.makeFormatterDefault();

export function storedValueDecoder<S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  table: string,
) {
  const decode = Schema.decodeUnknownResult(schema, {
    onExcessProperty: "error",
  });

  return flow(
    decode,
    Result.getOrThrowWith(
      (error: Schema.SchemaError) =>
        new StoredDataError(
          `Invalid persisted ${table} record: ${formatIssue(error.issue)}. Restore valid storage.`,
          { cause: error },
        ),
    ),
  );
}

export const storedDecoder = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  table: string,
) => storedValueDecoder(Schema.fromJsonString(schema), table);
