import type { ComparisonOperand, Predicate } from "../../core/index.js";
import { currentBuilder } from "./builder.js";
import { type AuthorValue, type Ref, SIZE, type Size, serialize, serializeSize } from "./ref.js";

type Operand = AuthorValue | Size;

// BOUNDARY: A comparison lowers either an author value or the private size marker.
function operand(value: Operand): ComparisonOperand {
  const builder = currentBuilder();

  if (value !== null && typeof value === "object" && SIZE in value && value[SIZE] !== undefined) {
    return serializeSize(value[SIZE], builder);
  }

  return serialize(value, builder);
}

function compare(
  op: "eq" | "ne" | "lt" | "lte" | "gt" | "gte" | "in",
  left: Operand,
  right: Operand,
): Predicate {
  return currentBuilder().predicate({ op, left: operand(left), right: operand(right) });
}

export function eq(left: Operand, right: Operand) {
  return compare("eq", left, right);
}

export function ne(left: Operand, right: Operand) {
  return compare("ne", left, right);
}

export function lt(left: Operand, right: Operand) {
  return compare("lt", left, right);
}

export function lte(left: Operand, right: Operand) {
  return compare("lte", left, right);
}

export function gt(left: Operand, right: Operand) {
  return compare("gt", left, right);
}

export function gte(left: Operand, right: Operand) {
  return compare("gte", left, right);
}

export function in_(left: Operand, right: readonly AuthorValue[]) {
  return compare("in", left, right);
}

export function exists(value: AuthorValue): Predicate {
  return currentBuilder().predicate({ op: "exists", value: serialize(value, currentBuilder()) });
}

export function isNull(value: AuthorValue): Predicate {
  return currentBuilder().predicate({ op: "isNull", value: serialize(value, currentBuilder()) });
}

export function size(value: Ref<string | readonly unknown[] | undefined>): Size {
  return { [SIZE]: value };
}

export function and(...predicates: Predicate[]): Predicate {
  return currentBuilder().predicate({ op: "and", predicates });
}

export function or(...predicates: Predicate[]): Predicate {
  return currentBuilder().predicate({ op: "or", predicates });
}

export function not(predicate: Predicate): Predicate {
  return currentBuilder().predicate({ op: "not", predicate });
}
