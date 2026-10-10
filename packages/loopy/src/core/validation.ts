/**
 * Guards for data that arrives from outside the type system: JSON files, HTTP
 * bodies, queue messages and `unknown` module exports. Each guard names the
 * location it is checking so an error tells the reader where the bad value is.
 */
// BOUNDARY: JSON files, HTTP bodies and imported module fields remain untrusted until their domain validators check each field.
export type UnknownRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString);
}

// BOUNDARY: External JSON or module values must be non-null, non-array objects before domain fields are inspected.
export function requireRecord(value: unknown, location: string): UnknownRecord {
  if (!isRecord(value)) {
    throw new Error(`${location} must be an object.`);
  }

  return value;
}

// BOUNDARY: External JSON and module fields must be strings before their callers consume them.
export function requireString(value: unknown, location: string): string {
  if (typeof value !== "string") {
    throw new Error(`${location} must be a string.`);
  }

  return value;
}

// BOUNDARY: External JSON and module fields must be nonempty strings before their callers consume them.
export function requireNonEmptyString(value: unknown, location: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${location} is required.`);
  }

  return value;
}

// BOUNDARY: External HTTP and JSON fields must be booleans before their callers consume them.
export function requireBoolean(value: unknown, location: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${location} must be a boolean.`);
  }

  return value;
}

// BOUNDARY: External workflow fields must be positive safe integers before execution limits are applied.
export function requirePositiveInteger(value: unknown, location: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${location} must be a positive integer.`);
  }

  return value;
}

// BOUNDARY: External workflow and HTTP fields must match one of the supplied string enum choices.
export function requireOneOf<const Choices extends readonly string[]>(
  value: unknown,
  choices: Choices,
  location: string,
): Choices[number] {
  if (typeof value !== "string" || !choices.includes(value)) {
    throw new Error(`${location} must be one of ${choices.join(", ")}.`);
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
      throw new Error(`${location} has an unsupported field '${key}'.`);
    }
  }
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
