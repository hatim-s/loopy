import { Schema } from "effect";
import { executionKeySchema, hookRecordSchema, outputSchema } from "../contract/index.js";

export const waitRecordSchema = Schema.Struct({
  ...hookRecordSchema.fields,
  executionKey: executionKeySchema,
  schema: outputSchema,
});
