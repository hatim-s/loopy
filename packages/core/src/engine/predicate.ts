import { isRef } from "../graph/ref";
import type { ComparisonOperand, Predicate } from "../graph/values";
import type { Json } from "../json";
import { isNumber, isRecord, isString } from "../validation";
import { type ResolutionContext, reference, resolve } from "./resolve";
import type { EngineState } from "./state";

function operand(value: ComparisonOperand, state: EngineState, context: ResolutionContext): Json {
  const result = resolve(value, state, context);

  if (isRef(value) && "size" in value) {
    if (!isString(result) && !Array.isArray(result)) {
      throw new Error("size requires an array or string.");
    }

    return result.length;
  }

  return result;
}

function equal(left: Json, right: Json): boolean {
  if (left === right) {
    return true;
  }

  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length &&
      left.every((value, index) => equal(value, right[index] ?? null))
    );
  }

  if (isRecord(left) && isRecord(right)) {
    return (
      Object.keys(left).length === Object.keys(right).length &&
      Object.entries(left).every(
        ([key, value]) => Object.hasOwn(right, key) && equal(value, right[key] ?? null),
      )
    );
  }

  return false;
}

export function predicate(
  test: Predicate,
  state: EngineState,
  context: ResolutionContext,
): boolean {
  switch (test.op) {
    case "and":
      return test.predicates.every((value) => predicate(value, state, context));
    case "or":
      return test.predicates.some((value) => predicate(value, state, context));
    case "not":
      return !predicate(test.predicate, state, context);
    case "exists":
      return isRef(test.value) ? reference(test.value, state, context) !== undefined : true;
    case "isNull":
      return resolve(test.value, state, context) === null;
  }

  const left = operand(test.left, state, context);
  const right = operand(test.right, state, context);

  switch (test.op) {
    case "eq":
      return equal(left, right);
    case "ne":
      return !equal(left, right);
    case "in": {
      if (!Array.isArray(right)) {
        throw new Error("in requires an array on the right.");
      }

      return right.some((value) => equal(left, value));
    }

    default: {
      if (!((isNumber(left) && isNumber(right)) || (isString(left) && isString(right)))) {
        throw new Error("Ordered comparisons require matching strings or numbers.");
      }

      switch (test.op) {
        case "lt":
          return left < right;
        case "lte":
          return left <= right;
        case "gt":
          return left > right;
        case "gte":
          return left >= right;
      }
    }
  }
}
