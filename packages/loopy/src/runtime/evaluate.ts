import type { Json } from "../core/index.js";
import { isBoolean, isNumber, isString } from "../core/index.js";

const COMPARISONS = {
  gt: (left: number, right: number) => left > right,
  gte: (left: number, right: number) => left >= right,
  lt: (left: number, right: number) => left < right,
  lte: (left: number, right: number) => left <= right,
};

/** Applies one operator to already-resolved operands. */
// BOUNDARY: Persisted expression operators select a known operation whose resolved JSON operands are checked for the required kinds.
export function evaluate(op: unknown, values: Json[]): Json {
  const [first, second] = values;

  switch (op) {
    case "eq":
      return Object.is(first, second);
    case "ne":
      return !Object.is(first, second);
    case "gt":
    case "gte":
    case "lt":
    case "lte":
      if (!isNumber(first) || !isNumber(second)) {
        throw new Error(`${op} requires numbers.`);
      }

      return COMPARISONS[op](first, second);
    case "and":
    case "or":
      if (values.some((item) => !isBoolean(item))) {
        throw new Error(`${op} requires booleans.`);
      }

      return op === "and" ? values.every(Boolean) : values.some(Boolean);
    case "not":
      if (!isBoolean(first)) {
        throw new Error("not requires a boolean.");
      }

      return !first;
    case "contains":
      if (!isString(first) || !isString(second)) {
        throw new Error("contains requires strings.");
      }

      return first.includes(second);
    case "concat":
      if (values.some((item) => !isString(item) && !isNumber(item))) {
        throw new Error("concat requires strings or numbers.");
      }

      return values.join("");
    default:
      throw new Error(`Unsupported expression operator ${String(op)}.`);
  }
}
