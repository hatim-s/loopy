import { DIAGNOSTIC_MESSAGES, type DiagnosticCode } from "./diagnostics.js";
import {
  type ComparisonOperand,
  PREDICATE_SHAPES,
  type Predicate,
  predicateIs,
  type Ref,
  type Value,
  type ValueType,
} from "./graph.js";
import { isRef, refs } from "./graph-values.js";
import { isBoolean, isNumber, isString } from "./validation.js";

export type ResolveType = (ref: Ref) => ValueType | null;

type PredicateIssue = { code: DiagnosticCode; message: string };

function issue(code: DiagnosticCode): PredicateIssue {
  return { code, message: DIAGNOSTIC_MESSAGES[code] };
}

export function arrayType(type: ValueType | null): ValueType {
  switch (type) {
    case "string":
      return "string[]";
    case "number":
      return "number[]";
    case "boolean":
      return "boolean[]";
    case "never":
      return "never";
    default:
      return "json[]";
  }
}

export function elementType(type: ValueType | null): ValueType {
  switch (type) {
    case "string[]":
      return "string";
    case "number[]":
      return "number";
    case "boolean[]":
      return "boolean";
    default:
      return "json";
  }
}

export function operandType(value: ComparisonOperand, resolveType: ResolveType): ValueType | null {
  if (isRef(value)) {
    return "size" in value ? "number" : resolveType(value);
  }
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    const elements = value.map((item) => operandType(item, resolveType));
    const type = elements[0] ?? null;
    return elements.every((element) => element === type) ? arrayType(type) : "json[]";
  }
  if (isString(value)) {
    return "string";
  }
  if (isNumber(value)) {
    return "number";
  }
  if (isBoolean(value)) {
    return "boolean";
  }
  return "object";
}

export function hasSize(value: Value): boolean {
  return refs(value).some((ref) => "size" in ref);
}

function comparisonErrors(
  resolveType: ResolveType,
  predicate: Extract<Predicate, { left: ComparisonOperand }>,
): PredicateIssue[] {
  const invalidSize = [predicate.left, predicate.right].some((operand) => {
    if (!isRef(operand) || !("size" in operand)) {
      return hasSize(operand);
    }
    const type = resolveType(operand);
    return type !== "string" && !type?.endsWith("[]");
  });
  if (invalidSize) {
    return [issue("invalid_size")];
  }
  const left = operandType(predicate.left, resolveType);
  const right = operandType(predicate.right, resolveType);
  let mismatch: boolean;
  switch (PREDICATE_SHAPES[predicate.op]) {
    case "membership":
      if (Array.isArray(predicate.right)) {
        mismatch =
          left === null ||
          left === "json" ||
          predicate.right.some((member) => operandType(member, resolveType) !== left);
      } else {
        mismatch = !right?.endsWith("[]") || elementType(right) !== left || left === "json";
      }
      break;
    case "ordering":
      mismatch = left !== right || (left !== "number" && left !== "string");
      break;
    case "equality":
      mismatch = left !== null && right !== null && left !== right;
      break;
  }
  return mismatch ? [issue("predicate_type")] : [];
}

export function checkPredicate(predicate: Predicate, resolveType: ResolveType): PredicateIssue[] {
  if (predicateIs(predicate, "group")) {
    return predicate.predicates.flatMap((child) => checkPredicate(child, resolveType));
  }
  if (predicateIs(predicate, "negation")) {
    return checkPredicate(predicate.predicate, resolveType);
  }
  if (predicateIs(predicate, "presence")) {
    return [];
  }
  return comparisonErrors(resolveType, predicate);
}

export function predicateValues(predicate: Predicate): ComparisonOperand[] {
  if (predicateIs(predicate, "group")) {
    return predicate.predicates.flatMap(predicateValues);
  }
  if (predicateIs(predicate, "negation")) {
    return predicateValues(predicate.predicate);
  }
  if (predicateIs(predicate, "presence")) {
    return [predicate.value];
  }
  return [predicate.left, predicate.right];
}
