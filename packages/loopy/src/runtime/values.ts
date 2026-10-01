import type { ArgConstraint, CommandNode, Json, ResolvedCommand } from "../core/model.js";

export type Outputs = Map<string, Json>;

const maxDepth = 32;

export function assertJson(
  value: unknown,
  path = "input",
  seen = new Set<object>(),
  depth = 0,
): asserts value is Json {
  if (depth > maxDepth) throw new Error(`${path} is too deeply nested`);
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (!value || typeof value !== "object") throw new Error(`${path} must be JSON data`);
  if (seen.has(value)) throw new Error(`${path} contains a cycle`);
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null)
    throw new Error(`${path} must be a plain JSON object`);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1)
      if (!Object.hasOwn(value, index)) throw new Error(`${path} cannot contain array holes`);
    if (Object.keys(value).length !== value.length)
      throw new Error(`${path} cannot contain extra array properties`);
  }
  seen.add(value);
  for (const [key, child] of Object.entries(value))
    assertJson(child, `${path}.${key}`, seen, depth + 1);
  seen.delete(value);
}

function pathValue(value: Json, path: readonly string[], label: string): Json {
  let current: Json = value;
  for (const key of path) {
    if (Array.isArray(current)) {
      const index = Number(key);
      if (!Number.isInteger(index) || index < 0 || index >= current.length)
        throw new Error(`Missing ${label}.${key}`);
      current = current[index] as Json;
    } else if (current && typeof current === "object" && Object.hasOwn(current, key)) {
      current = current[key] as Json;
    } else {
      throw new Error(`Missing ${label}.${key}`);
    }
  }
  return current;
}

const compare = {
  gt: (left: number, right: number) => left > right,
  gte: (left: number, right: number) => left >= right,
  lt: (left: number, right: number) => left < right,
  lte: (left: number, right: number) => left <= right,
};

function evaluate(op: unknown, values: Json[]): Json {
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
      if (typeof first !== "number" || typeof second !== "number")
        throw new Error(`${op} requires numbers`);
      return compare[op](first, second);
    case "and":
    case "or":
      if (values.some((item) => typeof item !== "boolean"))
        throw new Error(`${op} requires booleans`);
      return op === "and" ? values.every(Boolean) : values.some(Boolean);
    case "not":
      if (typeof first !== "boolean") throw new Error("not requires a boolean");
      return !first;
    case "contains":
      if (typeof first !== "string" || typeof second !== "string")
        throw new Error("contains requires strings");
      return first.includes(second);
    case "concat":
      if (values.some((item) => typeof item !== "string" && typeof item !== "number"))
        throw new Error("concat requires strings or numbers");
      return values.join("");
    default:
      throw new Error(`Unsupported expression ${String(op)}`);
  }
}

/** Replaces references and expressions inside a persisted value with run data. */
export function resolveValue(value: unknown, input: Json, outputs: Outputs): Json {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Workflow value must be finite");
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => resolveValue(item, input, outputs));
  if (!value || typeof value !== "object") throw new Error("Unsupported workflow value");
  const record = value as Record<string, unknown>;
  if ("$ref" in record) {
    const ref = record.$ref as { source: "input" | "steps"; path: string[] };
    if (!Array.isArray(ref.path) || ref.path.some((part) => typeof part !== "string"))
      throw new Error("Invalid workflow reference path");
    if (ref.source === "input") return pathValue(input, ref.path, "input");
    const [step, ...path] = ref.path;
    if (!step || !outputs.has(step)) throw new Error(`Output for ${step ?? "step"} is unavailable`);
    return pathValue(outputs.get(step) as Json, path, `steps.${step}`);
  }
  if ("$op" in record) {
    if (!Array.isArray(record.args)) throw new Error("Expression args must be an array");
    return evaluate(
      record.$op,
      record.args.map((arg) => resolveValue(arg, input, outputs)),
    );
  }
  return Object.fromEntries(
    Object.entries(record).map(([key, item]) => [key, resolveValue(item, input, outputs)]),
  );
}

function stringValue(value: Json, label: string): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  throw new Error(`${label} must resolve to a string or number`);
}

/** Checks one resolved argv entry against the constraint its typed wrapper recorded. */
function checkConstraint(
  arg: unknown,
  value: Json,
  constraint: ArgConstraint,
  label: string,
  input: Json,
  outputs: Outputs,
): void {
  let checked = value;
  if (constraint.prefix !== undefined) {
    const attached = arg as { $op?: unknown; args?: unknown[] } | null;
    if (
      !attached ||
      typeof attached !== "object" ||
      attached.$op !== "concat" ||
      attached.args?.length !== 2 ||
      attached.args[0] !== constraint.prefix
    )
      throw new Error(`${label} has an invalid attached flag`);
    if (typeof value !== "string" || !value.startsWith(constraint.prefix))
      throw new Error(`${label} must start with ${constraint.prefix}`);
    checked = resolveValue(attached.args[1], input, outputs);
  }
  if (typeof checked !== constraint.kind)
    throw new Error(`${label} must resolve to a ${constraint.kind}`);
  if (constraint.choices && typeof checked === "string" && !constraint.choices.includes(checked))
    throw new Error(`${label} must be one of ${constraint.choices.join(", ")}`);
}

export function resolveCommand(node: CommandNode, input: Json, outputs: Outputs): ResolvedCommand {
  const source = node.command;
  const args = source.args.map((arg, index) => {
    const label = `Argument ${index + 1}`;
    const value = resolveValue(arg, input, outputs);
    const constraint = source.argConstraints?.[index];
    if (constraint) checkConstraint(arg, value, constraint, label, input, outputs);
    return stringValue(value, label);
  });
  const env = source.env
    ? Object.fromEntries(
        Object.entries(source.env).map(([key, value]) => [
          key,
          stringValue(resolveValue(value, input, outputs), `Environment ${key}`),
        ]),
      )
    : undefined;
  return {
    program: source.program,
    args,
    stdin:
      source.stdin === undefined
        ? undefined
        : stringValue(resolveValue(source.stdin, input, outputs), "stdin"),
    env,
    cwd: source.cwd,
    timeoutMs: source.timeoutMs,
    maxOutputBytes: source.maxOutputBytes,
  };
}
