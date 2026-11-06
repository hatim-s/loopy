import { executionKeySchema, hookRecordSchema, outputSchema } from "@loopy/contract";
import { Schema } from "effect";

export const waitRecordSchema = Schema.Struct({
  ...hookRecordSchema.fields,
  executionKey: executionKeySchema,
  schema: outputSchema,
});
