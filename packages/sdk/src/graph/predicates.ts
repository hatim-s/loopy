import type { COMPARISON_OPS, ComparisonOperand } from "@loopy/core";
import {
  type AuthorValue,
  Condition,
  type Ref,
  type RefContext,
  type RefValue,
  Size,
  serialize,
  serializeRef,
} from "./ref";

type Operand = AuthorValue | Size;

type Scalar = string | number | boolean;

type Comparison = (typeof COMPARISON_OPS)[number];

type Numeric = Ref<number> | number | Size;

type Text = Ref<string> | string;

type Ordering = {
  (left: Numeric, right: Numeric): Condition;
  (left: Text, right: Text): Condition;
};

function operand(value: Operand, context: RefContext): ComparisonOperand {
  if (value instanceof Size) {
    return { ...serializeRef(value.ref, context), size: true };
  }

  return serialize(value, context);
}

function compare(op: Comparison, left: Operand, right: Operand) {
  return new Condition((context) => ({
    op,
    left: operand(left, context),
    right: operand(right, context),
  }));
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
  return new Condition((context) => ({ op: "exists", value: serialize(value, context) }));
}

export function isNull(value: RefValue) {
  return new Condition((context) => ({ op: "isNull", value: serialize(value, context) }));
}

export function size(value: Ref<string> | Ref<unknown[]>): Size {
  return new Size(value);
}

export function and(...conditions: Condition[]) {
  return new Condition((context) => ({
    op: "and",
    predicates: conditions.map((condition) => condition.lower(context)),
  }));
}

export function or(...conditions: Condition[]) {
  return new Condition((context) => ({
    op: "or",
    predicates: conditions.map((condition) => condition.lower(context)),
  }));
}

export function not(condition: Condition) {
  return new Condition((context) => ({ op: "not", predicate: condition.lower(context) }));
}
