import { type COMPARISON_OPS, type ComparisonOperand, type Predicate } from "../../core/index.js";
import {
  type AuthorValue,
  type Ref,
  type RefContext,
  type RefValue,
  Size,
  serialize,
  serializeSize,
} from "./ref.js";

const PREDICATE = Symbol("loopy.predicate");

type Operand = AuthorValue | Size;

type Scalar = string | number | boolean;

type Comparison = (typeof COMPARISON_OPS)[number];

type Numeric = Ref<number> | number | Size;

type Text = Ref<string> | string;

type PredicateData =
  | { op: Comparison; left: Operand; right: Operand }
  | { op: "exists" | "isNull"; value: RefValue }
  | { op: "and" | "or"; predicates: AuthorPredicate[] }
  | { op: "not"; predicate: AuthorPredicate };

export type AuthorPredicate = PredicateData & { readonly [PREDICATE]: true };

type Ordering = {
  (left: Numeric, right: Numeric): AuthorPredicate;
  (left: Text, right: Text): AuthorPredicate;
};

function predicate(value: PredicateData): AuthorPredicate {
  return { ...value, [PREDICATE]: true };
}

function operand(value: Operand, context: RefContext): ComparisonOperand {
  return value instanceof Size ? serializeSize(value.ref, context) : serialize(value, context);
}

export function serializePredicate(value: AuthorPredicate, context: RefContext): Predicate {
  if ("predicates" in value) {
    return {
      op: value.op,
      predicates: value.predicates.map((child) => serializePredicate(child, context)),
    };
  }

  if ("predicate" in value) {
    return { op: value.op, predicate: serializePredicate(value.predicate, context) };
  }

  if ("value" in value) {
    return { op: value.op, value: serialize(value.value, context) };
  }

  return { op: value.op, left: operand(value.left, context), right: operand(value.right, context) };
}

function compare(op: Comparison, left: Operand, right: Operand) {
  return predicate({ op, left, right });
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

export function exists(value: RefValue) {
  return predicate({ op: "exists", value });
}

export function isNull(value: RefValue) {
  return predicate({ op: "isNull", value });
}

export function size(value: Ref<string> | Ref<unknown[]>): Size {
  return new Size(value);
}

export function and(...predicates: AuthorPredicate[]) {
  return predicate({ op: "and", predicates });
}

export function or(...predicates: AuthorPredicate[]) {
  return predicate({ op: "or", predicates });
}

export function not(value: AuthorPredicate) {
  return predicate({ op: "not", predicate: value });
}
