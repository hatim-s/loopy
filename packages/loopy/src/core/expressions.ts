import type { Expression, FilePath, Operator, Scalar, Value } from "./model.js";

function expression<T>(op: Operator, ...args: unknown[]): Expression<T> {
  return { $op: op, args };
}

export const eq = <T extends Scalar>(left: Value<T>, right: Value<T>): Expression<boolean> =>
  expression("eq", left, right);
export const ne = <T extends Scalar>(left: Value<T>, right: Value<T>): Expression<boolean> =>
  expression("ne", left, right);
export const gt = (left: Value<number>, right: Value<number>): Expression<boolean> =>
  expression("gt", left, right);
export const gte = (left: Value<number>, right: Value<number>): Expression<boolean> =>
  expression("gte", left, right);
export const lt = (left: Value<number>, right: Value<number>): Expression<boolean> =>
  expression("lt", left, right);
export const lte = (left: Value<number>, right: Value<number>): Expression<boolean> =>
  expression("lte", left, right);
export const and = (...values: Value<boolean>[]): Expression<boolean> =>
  expression("and", ...values);
export const or = (...values: Value<boolean>[]): Expression<boolean> => expression("or", ...values);
export const not = (value: Value<boolean>): Expression<boolean> => expression("not", value);
export const contains = (value: Value<string>, part: Value<string>): Expression<boolean> =>
  expression("contains", value, part);
export const concat = (...parts: Value<string | number>[]): Expression<string> =>
  expression("concat", ...parts);

/** Marks a string as a path relative to the workflow file, so a global save can pin it. */
export function file(path: string): FilePath {
  if (!path.trim()) {
    throw new Error("A file path is required.");
  }
  return { $file: path };
}
