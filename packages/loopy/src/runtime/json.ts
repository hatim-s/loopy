import type { Json } from "../core/index.js";
import { isBoolean, isNumber, isString } from "../core/index.js";

const MAX_DEPTH = 32;

function assertPlainContainer(value: unknown, path: string): asserts value is object {
  if (value === null || typeof value !== "object") {
    throw new Error(`${path} must be a JSON container.`);
  }

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) {
        throw new Error(`${path} cannot contain array holes.`);
      }
    }

    if (Object.keys(value).length !== value.length) {
      throw new Error(`${path} cannot contain extra array properties.`);
    }

    return;
  }

  const prototype = Object.getPrototypeOf(value);

  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${path} must be a plain JSON object.`);
  }
}

/** Rejects anything JSON.stringify would silently drop or reshape: cycles, holes, class instances. */
export function assertJson(
  value: unknown,
  path = "input",
  seen = new Set<object>(),
  depth = 0,
): asserts value is Json {
  if (depth > MAX_DEPTH) {
    throw new Error(`${path} is too deeply nested.`);
  }

  if (value === null || isString(value) || isBoolean(value)) {
    return;
  }

  if (isNumber(value) && Number.isFinite(value)) {
    return;
  }

  if (!value || typeof value !== "object") {
    throw new Error(`${path} must be JSON data.`);
  }

  if (seen.has(value)) {
    throw new Error(`${path} contains a cycle.`);
  }

  assertPlainContainer(value, path);
  seen.add(value);

  for (const [key, child] of Object.entries(value)) {
    assertJson(child, `${path}.${key}`, seen, depth + 1);
  }

  seen.delete(value);
}
