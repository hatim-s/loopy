import { executionKeySchema, hookRecordSchema, outputSchema } from "../contract/index.js";

export const waitRecordSchema = hookRecordSchema.extend({
  executionKey: executionKeySchema,
  schema: outputSchema,
});
