import { Schema } from "effect";
import { executionKeySchema, hookRecordSchema, outputSchema } from "../contract";

export const waitRecordSchema = Schema.Struct({
  ...hookRecordSchema.fields,
  executionKey: executionKeySchema,
  schema: outputSchema,
});
