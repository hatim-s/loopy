import { isRecord } from "./validation.js";

// BOUNDARY: Canonical JSON accepts serializable records, including optional fields omitted by JSON.
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }

  if (isRecord(value)) {
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }

  const encoded = JSON.stringify(value);

  if (encoded === undefined) {
    throw new Error("Canonical JSON requires a JSON value.");
  }

  return encoded;
}
