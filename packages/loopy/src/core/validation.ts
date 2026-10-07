/**
 * Guards for data that arrives from outside the type system: JSON files, HTTP
 * bodies, queue messages and `unknown` module exports. Each guard names the
 * location it is checking so an error tells the reader where the bad value is.
 */
export type UnknownRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function requireRecord(value: unknown, location: string): UnknownRecord {
  if (!isRecord(value)) {
    throw new Error(`${location} must be an object`);
  }
  return value;
}

export function requireString(value: unknown, location: string): string {
  if (typeof value !== "string") {
    throw new Error(`${location} must be a string`);
  }
  return value;
}

export function requireNonEmptyString(value: unknown, location: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${location} is required`);
  }
  return value;
}

export function requireBoolean(value: unknown, location: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${location} must be a boolean`);
  }
  return value;
}

export function requirePositiveInteger(value: unknown, location: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${location} must be a positive integer`);
  }
  return value;
}

export function requireOneOf<const Choices extends readonly string[]>(
  value: unknown,
  choices: Choices,
  location: string,
): Choices[number] {
  if (typeof value !== "string" || !choices.includes(value)) {
    throw new Error(`${location} must be one of ${choices.join(", ")}`);
  }
  return value;
}

/** Rejects keys the schema does not know, so a typo never silently disappears. */
export function allowKeys(
  value: UnknownRecord,
  location: string,
  allowed: readonly string[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new Error(`${location} has an unsupported field '${key}'`);
    }
  }
}

/**
 * Sets a key on a record built from untrusted keys without touching the
 * prototype chain. `record[key] = value` with key `__proto__` would.
 */
export function setOwnProperty<T>(record: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(record, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}
