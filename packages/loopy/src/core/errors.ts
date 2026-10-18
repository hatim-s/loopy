import { isRecord, isString } from "./validation.js";

/** The message of anything thrown, for logs and API responses. */
export function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function errnoCode(cause: unknown): string | undefined {
  return isRecord(cause) && isString(cause.code) ? cause.code : undefined;
}

export function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}
