import { type COMPARISON_OPS, type ComparisonOperand, type Predicate } from "../../core/index.js";
import { currentBuilder } from "./builder.js";
import {
  type AuthorValue,
  checkSerialized,
  type Ref,
  type RefValue,
  SIZE,
  type Size,
  serialize,
  serializeSize,
} from "./ref.js";
import { validatePredicate } from "./validate.js";

type Operand = AuthorValue | Size;

type Scalar = string | number | boolean;

type Comparison = (typeof COMPARISON_OPS)[number];

type Numeric = Ref<number> | number | Size;

type Text = Ref<string> | string;

type Ordering = {
  (left: Numeric, right: Numeric): Predicate;
  (left: Text, right: Text): Predicate;
};

// BOUNDARY: A comparison lowers either an author value or the private size marker.
function operand(value: Operand): ComparisonOperand {
  const builder = currentBuilder();

  if (value !== null && typeof value === "object" && SIZE in value && value[SIZE] !== undefined) {
    return serializeSize(value[SIZE], builder);
  }

  return serialize(value, builder);
}

export function recordPredicate(predicate: Predicate): Predicate {
  const builder = currentBuilder();

  if (predicate.op === "and" || predicate.op === "or") {
    predicate.predicates.forEach(recordPredicate);
  } else if (predicate.op === "not") {
    recordPredicate(predicate.predicate);
  } else if ("value" in predicate) {
    checkSerialized(predicate.value, builder);
  } else if ("left" in predicate) {
    checkSerialized(predicate.left, builder);
    checkSerialized(predicate.right, builder);
  }

  validatePredicate(predicate, builder);

  return predicate;
}

function compare(op: Comparison, left: Operand, right: Operand): Predicate {
  return recordPredicate({ op, left: operand(left), right: operand(right) });
}

export function eq<T extends Scalar>(left: Ref<T>, right: Ref<NoInfer<T>> | NoInfer<T>) {
  return compare("eq", left, right);
}

export function ne<T extends Scalar>(left: Ref<T>, right: Ref<NoInfer<T>> | NoInfer<T>) {
  return compare("ne", left, right);
}

export const lt: Ordering = (left: Operand, right: Operand) => compare("lt", left, right);

export const lte: Ordering = (left: Operand, right: Operand) => compare("lte", left, right);

export const gt: Ordering = (left: Operand, right: Operand) => compare("gt", left, right);

export const gte: Ordering = (left: Operand, right: Operand) => compare("gte", left, right);

export function in_<T extends Scalar>(left: Ref<T>, right: Ref<NoInfer<T>[]> | NoInfer<T>[]) {
  return compare("in", left, right);
}

export function exists(value: RefValue): Predicate {
  return recordPredicate({ op: "exists", value: serialize(value, currentBuilder()) });
}

export function isNull(value: RefValue): Predicate {
  return recordPredicate({ op: "isNull", value: serialize(value, currentBuilder()) });
}

export function size(value: Ref<string> | Ref<unknown[]>): Size {
  return { [SIZE]: value };
}

export function and(...predicates: Predicate[]): Predicate {
  return recordPredicate({ op: "and", predicates });
}

export function or(...predicates: Predicate[]): Predicate {
  return recordPredicate({ op: "or", predicates });
}

export function not(predicate: Predicate): Predicate {
  return recordPredicate({ op: "not", predicate });
}
