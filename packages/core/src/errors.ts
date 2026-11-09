import { Data } from "effect";
import { isRecord, isString } from "./validation";

export function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function errnoCode(cause: unknown): string | undefined {
  return isRecord(cause) && isString(cause.code) ? cause.code : undefined;
}

export class SecretError extends Data.TaggedError("SecretError")<{
  operation: "read" | "get" | "validate" | "set" | "remove";
  reason: "invalid" | "missing" | "io";
  cause: unknown;
}> {}
