import type { Expression, FilePath, Operator, Scalar, Value } from "./model.js";

function expression<T>(op: Operator, ...args: unknown[]): Expression<T> {
  return { $op: op, args };
}

export function eq<T extends Scalar>(left: Value<T>, right: Value<T>): Expression<boolean> {
  return expression("eq", left, right);
}

export function ne<T extends Scalar>(left: Value<T>, right: Value<T>): Expression<boolean> {
  return expression("ne", left, right);
}

export function gt(left: Value<number>, right: Value<number>): Expression<boolean> {
  return expression("gt", left, right);
}

export function gte(left: Value<number>, right: Value<number>): Expression<boolean> {
  return expression("gte", left, right);
}

export function lt(left: Value<number>, right: Value<number>): Expression<boolean> {
  return expression("lt", left, right);
}

export function lte(left: Value<number>, right: Value<number>): Expression<boolean> {
  return expression("lte", left, right);
}

export function and(...values: Value<boolean>[]): Expression<boolean> {
  return expression("and", ...values);
}

export function or(...values: Value<boolean>[]): Expression<boolean> {
  return expression("or", ...values);
}

export function not(value: Value<boolean>): Expression<boolean> {
  return expression("not", value);
}

export function contains(value: Value<string>, part: Value<string>): Expression<boolean> {
  return expression("contains", value, part);
}

export function concat(...parts: Value<string | number>[]): Expression<string> {
  return expression("concat", ...parts);
}

/** Marks a string as a path relative to the workflow file, so a global save can pin it. */
export function file(path: string): FilePath {
  if (!path.trim()) {
    throw new Error("A file path is required.");
  }
  return { $file: path };
}
