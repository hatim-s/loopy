import type { Json } from "../core/index.js";

const COMPARISONS = {
  gt: (left: number, right: number) => left > right,
  gte: (left: number, right: number) => left >= right,
  lt: (left: number, right: number) => left < right,
  lte: (left: number, right: number) => left <= right,
};

/** Applies one operator to already-resolved operands. */
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
      if (typeof first !== "number" || typeof second !== "number") {
        throw new Error(`${op} requires numbers.`);
      }
      return COMPARISONS[op](first, second);
    case "and":
    case "or":
      if (values.some((item) => typeof item !== "boolean")) {
        throw new Error(`${op} requires booleans.`);
      }
      return op === "and" ? values.every(Boolean) : values.some(Boolean);
    case "not":
      if (typeof first !== "boolean") {
        throw new Error("not requires a boolean.");
      }
      return !first;
    case "contains":
      if (typeof first !== "string" || typeof second !== "string") {
        throw new Error("contains requires strings.");
      }
      return first.includes(second);
    case "concat":
      if (values.some((item) => typeof item !== "string" && typeof item !== "number")) {
        throw new Error("concat requires strings or numbers.");
      }
      return values.join("");
    default:
      throw new Error(`Unsupported expression operator ${String(op)}.`);
  }
}
