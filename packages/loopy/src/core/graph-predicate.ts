import type { Diagnostic, DiagnosticCode } from "./diagnostics.js";
import type { ComparisonOperand, Predicate, Value } from "./graph.js";
import { refs } from "./graph-context.js";
import { isRef } from "./graph-ref.js";
import { isBoolean, isNumber, isString } from "./validation.js";

export type ResolveType = (ref: { ref: string; path: string[] }) => string | null;

type PredicateIssue = { code: DiagnosticCode; message: string };

function issue(code: message: string): PredicateIssue {
  return { code, message };
}

export function operandType(value: ComparisonOperand, resolveType: ResolveType): string | null {
  if (isRef(value)) {
    return "size" in value ? "number" : resolveType(value);
  }

  if (value === null) {
    return "null";
  }

  if (Array.isArray(value)) {
    const elements = value.map((item) => operandType(item, resolveType));
    const type = elements[0];
    const scalar = type === "string" || type === "number" || type === "boolean";

    return `${scalar && elements.every((element) => element === type) ? type : "json"}[]`;
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
  const left = operandType(predicate.left, resolveType);
  const right = operandType(predicate.right, resolveType);

  const invalidSize = [predicate.left, predicate.right].some((operand) => {
    if (!isRef(operand) || !("size" in operand)) {
      return hasSize(operand);
    }

    const type = resolveType(operand);

    return operand.size !== true || (type !== "string" && !type?.endsWith("[]"));
  });

  if (invalidSize) {
    return [issue("invalid_size", "Size requires a string or array reference in a comparison.")];
  }

  const ordering = ["lt", "lte", "gt", "gte"].includes(predicate.op);

  const mismatch =
    predicate.op === "in"
      ? !Array.isArray(predicate.right) &&
        (!right?.endsWith("[]") || right.slice(0, -2) !== left || left === "json")
      : ordering
        ? left !== right || (left !== "number" && left !== "string")
        : left !== null && right !== null && left !== right;

  const members = predicate.op === "in" && Array.isArray(predicate.right) ? predicate.right : [];

  const badMember =
    predicate.op === "in" &&
    (left === null ||
      left === "json" ||
      members.some((member) => operandType(member, resolveType) !== left));

  return mismatch || badMember
    ? [issue("predicate_type", "Predicate operands must have matching declared types.")]
    : [];
}

export function checkPredicate(predicate: Predicate, resolveType: ResolveType): PredicateIssue[] {
  switch (predicate.op) {
    case "and":
    case "or":
      return predicate.predicates.flatMap((child) => checkPredicate(child, resolveType));
    case "not":
      return checkPredicate(predicate.predicate, resolveType);
    case "exists":
    case "isNull":
      return hasSize(predicate.value)
        ? [issue("invalid_size", "Size is allowed only in comparisons.")]
        : [];
    default:
      return comparisonErrors(resolveType, predicate);
  }
}
