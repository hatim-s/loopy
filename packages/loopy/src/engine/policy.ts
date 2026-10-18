import {
  type ExecutionError,
  type GraphRetry,
  isFieldValue,
  type Json,
  MAX_OUTPUT_BYTES,
  matchesRecord,
  OUTPUT_LIMIT_MESSAGE,
  type OutSchema,
  outputBytes,
} from "../core/index.js";

export function validateOutput(output: Json, schema: OutSchema): ExecutionError | null {
  const limit = outputLimitError(output);

  if (limit) {
    return limit;
  }

  const valid =
    schema === null
      ? output === null
      : schema.kind === "value"
        ? isFieldValue(schema.type, output)
        : matchesRecord(schema.fields, output, { extraKeys: "allow" });

  return valid
    ? null
    : { code: "validation", message: "Node output does not match its declared out schema." };
}

export function outputLimitError(output: Json): ExecutionError | null {
  return outputBytes(output) > MAX_OUTPUT_BYTES
    ? { code: "output_limit", message: OUTPUT_LIMIT_MESSAGE }
    : null;
}

export function retryDelayMs(attempt: number): number {
  return Math.min(1000 * 2 ** (attempt - 1), 60_000);
}

export function shouldRetry(error: ExecutionError, policy: GraphRetry): boolean {
  return error.code === "execution" || (error.code === "exit" && policy.retryOnExit);
}
