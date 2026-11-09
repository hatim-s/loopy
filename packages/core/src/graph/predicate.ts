import { isBoolean, isNumber, isString } from "../validation";
import type { DiagnosticCode } from ".";
import { refs } from "./context";
import { isRef } from "./ref";
import {
  arrayType,
  type ComparisonOperand,
  elementType,
  type GraphType,
  isScalarType,
  type Predicate,
  type RefLookup,
  type Value,
} from "./values";

export type ResolveType = (ref: RefLookup) => GraphType | null;

type PredicateIssue = { code: DiagnosticCode; message: string };

export function operandType(value: ComparisonOperand, resolveType: ResolveType): GraphType | null {
  if (isRef(value)) {
    return "size" in value ? "number" : resolveType(value);
  }

  if (value === null) {
    return "null";
  }

  if (Array.isArray(value)) {
    const [first = null, ...rest] = value.map((item) => operandType(item, resolveType));

    return arrayType(isScalarType(first) && rest.every((type) => type === first) ? first : null);
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

    return operand.size !== true || (type !== "string" && elementType(type) === null);
  });

  if (invalidSize) {
    return [
      {
        code: "invalid_size",
        message: "Size requires a string or array reference in a comparison.",
      },
    ];
  }

  const ordering = ["lt", "lte", "gt", "gte"].includes(predicate.op);

  const mismatch =
    predicate.op === "in"
      ? !Array.isArray(predicate.right) &&
        (elementType(right) === null || elementType(right) !== left || left === "json")
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
    ? [{ code: "predicate_type", message: "Predicate operands must have matching declared types." }]
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
        ? [{ code: "invalid_size", message: "Size is allowed only in comparisons." }]
        : [];
    default:
      return comparisonErrors(resolveType, predicate);
  }
}
