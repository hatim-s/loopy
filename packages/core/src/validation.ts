// BOUNDARY: JSON files, HTTP bodies and imported module fields remain untrusted until their domain validators check each field.
type UnknownRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString);
}

/**
 * Sets a key on a record built from untrusted keys without touching the
 * prototype chain. `record[key] = value` with key `__proto__` would.
 */
export function setOwnProperty<T>(record: Record<string, T> | T[], key: string, value: T): void {
  Object.defineProperty(record, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

export function isString(value: unknown): value is string {
  return typeof value === "string";
}

export function isNumber(value: unknown): value is number {
  return typeof value === "number";
}

export function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}
