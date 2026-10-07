import type { Operator } from "./model.js";
import {
  allowKeys,
  isRecord,
  requireNonEmptyString,
  requireOneOf,
  requireRecord,
  type UnknownRecord,
} from "./validation.js";

export const MAX_DEPTH = 32;
const ARITY: Record<Operator, number | "variadic"> = {
  eq: 2,
  ne: 2,
  gt: 2,
  gte: 2,
  lt: 2,
  lte: 2,
  and: "variadic",
  or: "variadic",
  not: 1,
  contains: 2,
  concat: "variadic",
};

function isOperator(value: unknown): value is Operator {
  return typeof value === "string" && Object.hasOwn(ARITY, value);
}

function isScalar(value: unknown): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return true;
  }
  return typeof value === "number" && Number.isFinite(value);
}

export function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function validateReference(raw: unknown, location: string, visible: ReadonlySet<string>): void {
  const ref = requireRecord(raw, location);
  allowKeys(ref, location, ["source", "path"]);
  const source = requireOneOf(ref.source, ["input", "steps"], `${location}.source`);
  const minimum = source === "steps" ? 2 : 1;
  const path = ref.path;
  if (!isStringList(path) || path.length < minimum || path.some((part) => !part)) {
    throw new Error(`${location}.path must list at least ${minimum} non-empty segments.`);
  }
  const step = path[0];
  if (source === "steps" && step !== undefined && !visible.has(step)) {
    throw new Error(`${location} references a step that is not available yet: ${step}.`);
  }
}

function validateExpression(
  item: UnknownRecord,
  location: string,
  visible: ReadonlySet<string>,
  depth: number,
): void {
  allowKeys(item, location, ["$op", "args"]);
  if (!isOperator(item.$op) || !Array.isArray(item.args)) {
    throw new Error(`${location} must name a known operator and list its args.`);
  }
  const expected = ARITY[item.$op];
  const count = item.args.length;
  if (expected === "variadic" ? count < 1 : count !== expected) {
    throw new Error(`${location} has the wrong number of operands for ${item.$op}.`);
  }
  for (const [index, arg] of item.args.entries()) {
    validateValue(arg, `${location}.args[${index}]`, visible, depth + 1);
  }
}

/** Accepts a JSON scalar, a reference to visible data, or an expression over those. */
export function validateValue(
  value: unknown,
  location: string,
  visible: ReadonlySet<string>,
  depth = 0,
): void {
  if (depth > MAX_DEPTH) {
    throw new Error(`${location} is too deeply nested.`);
  }
  if (isScalar(value)) {
    return;
  }
  if (!isRecord(value)) {
    throw new Error(`${location} must be a literal, reference, or expression.`);
  }
  if ("$file" in value) {
    allowKeys(value, location, ["$file"]);
    requireNonEmptyString(value.$file, `${location}.$file`);
    return;
  }
  if ("$ref" in value) {
    allowKeys(value, location, ["$ref"]);
    validateReference(value.$ref, `${location}.$ref`, visible);
    return;
  }
  if (!("$op" in value)) {
    throw new Error(`${location} must be a literal, reference, or expression.`);
  }
  validateExpression(value, location, visible, depth);
}
