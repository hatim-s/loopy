import { isRecord, isString, type Json } from "../core/index.js";

export function redactValue(input: Json, redact: (text: string) => string): Json {
  if (isString(input)) {
    return redact(input);
  }

  if (Array.isArray(input)) {
    return input.map((item) => redactValue(item, redact));
  }

  if (isRecord(input)) {
    return Object.fromEntries(
      Object.entries(input).map(([key, item]) => [redact(key), redactValue(item, redact)]),
    );
  }

  return input;
}
