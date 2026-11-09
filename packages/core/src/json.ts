import { Schema } from "effect";
import { isBoolean, isNumber, isString } from "./validation";

export const jsonSchema = Schema.MutableJson;

export type Json = Schema.Schema.Type<typeof jsonSchema>;

// JSON.parse turns 1e400 into Infinity, which serializes as null; the schema rejects it.
export const jsonTextSchema = Schema.fromJsonString(jsonSchema);

/** Decodes JSON text from argv, files and command output with the rule HTTP bodies use. */
export const decodeJsonText = Schema.decodeUnknownSync(jsonTextSchema);

export function isScalar(value: Json | undefined): value is string | number | boolean {
  return isString(value) || isNumber(value) || isBoolean(value);
}

export const MAX_OUTPUT_BYTES = 1024 * 1024;

export const MAX_LOG_BYTES = 64 * 1024;

// Views inline payloads up to this size and report only the byte count beyond it.
export const MAX_PREVIEW_BYTES = 16 * 1024;

export function outputBytes(output: Json): number {
  return new TextEncoder().encode(JSON.stringify(output)).byteLength;
}
