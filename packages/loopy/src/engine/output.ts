import {
  type ExecutionError,
  isFieldValue,
  isRecord,
  type Json,
  MAX_OUTPUT_BYTES,
  type OutSchema,
  outputBytes,
} from "../core/index.js";

export function validateOutput(output: Json, schema: OutSchema): ExecutionError | null {
  if (outputBytes(output) > MAX_OUTPUT_BYTES) {
    return { code: "output_limit", message: "Node output exceeds the 1 MiB inline limit." };
  }

  const valid =
    schema.kind === "value"
      ? isFieldValue(schema.type, output)
      : isRecord(output) &&
        Object.entries(schema.fields).every(([field, type]) => {
          const key = field.replace(/\?$/, "");

          return (
            (field.endsWith("?") && output[key] === undefined) || isFieldValue(type, output[key])
          );
        });

  return valid
    ? null
    : { code: "validation", message: "Node output does not match its declared out schema." };
}
