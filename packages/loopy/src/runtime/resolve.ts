import {
  type ArgConstraint,
  type CommandNode,
  isRecord,
  type Json,
  type ResolvedCommand,
  requireRecord,
} from "../core/index.js";
import { evaluate } from "./evaluate.js";

/** Outputs of settled nodes, keyed by node id, visible to later references. */
export type Outputs = Map<string, Json>;

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((part) => typeof part === "string");
}

function pathValue(value: Json, path: readonly string[], label: string): Json {
  let current: Json = value;
  for (const key of path) {
    if (Array.isArray(current)) {
      const index = Number(key);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        throw new Error(`Missing ${label}.${key}.`);
      }
      current = current[index] as Json;
    } else if (current && typeof current === "object" && Object.hasOwn(current, key)) {
      current = current[key] as Json;
    } else {
      throw new Error(`Missing ${label}.${key}.`);
    }
  }
  return current;
}

function resolveReference(raw: unknown, input: Json, outputs: Outputs): Json {
  const ref = requireRecord(raw, "Workflow reference");
  const path = ref.path;
  if (!isStringList(path)) {
    throw new Error("A workflow reference path must be a list of strings.");
  }
  if (ref.source === "input") {
    return pathValue(input, path, "input");
  }
  const [step, ...rest] = path;
  const output = step === undefined ? undefined : outputs.get(step);
  if (output === undefined) {
    throw new Error(`Output for ${step ?? "step"} is unavailable.`);
  }
  return pathValue(output, rest, `steps.${step}`);
}

function resolveExpression(op: unknown, args: unknown, input: Json, outputs: Outputs): Json {
  if (!Array.isArray(args)) {
    throw new Error("Expression args must be an array.");
  }
  return evaluate(
    op,
    args.map((arg) => resolveValue(arg, input, outputs)),
  );
}

/** Replaces references and expressions inside a persisted value with run data. */
export function resolveValue(value: unknown, input: Json, outputs: Outputs): Json {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("A workflow number must be finite.");
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolveValue(item, input, outputs));
  }
  if (!isRecord(value)) {
    throw new Error("Unsupported workflow value.");
  }
  if (typeof value.$file === "string") {
    return value.$file;
  }
  if ("$ref" in value) {
    return resolveReference(value.$ref, input, outputs);
  }
  if ("$op" in value) {
    return resolveExpression(value.$op, value.args, input, outputs);
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, resolveValue(item, input, outputs)]),
  );
}

function stringValue(value: Json, label: string): string {
  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }
  throw new Error(`${label} must resolve to a string or number.`);
}

/** The unresolved value operand of a concat(prefix, value) attached flag. */
function attachedOperand(arg: unknown, prefix: string, label: string): unknown {
  if (
    !isRecord(arg) ||
    arg.$op !== "concat" ||
    !Array.isArray(arg.args) ||
    arg.args.length !== 2 ||
    arg.args[0] !== prefix
  ) {
    throw new Error(`${label} must be an attached flag built from prefix '${prefix}'.`);
  }
  return arg.args[1];
}

/** Checks one resolved argv entry against the constraint its typed wrapper recorded. */
export function checkConstraint(
  arg: unknown,
  value: Json,
  constraint: ArgConstraint,
  label: string,
  input: Json,
  outputs: Outputs,
): void {
  let checked = value;
  if (constraint.prefix !== undefined) {
    const operand = attachedOperand(arg, constraint.prefix, label);
    if (typeof value !== "string" || !value.startsWith(constraint.prefix)) {
      throw new Error(`${label} must start with ${constraint.prefix}.`);
    }
    checked = resolveValue(operand, input, outputs);
  }
  if (typeof checked !== constraint.kind) {
    throw new Error(`${label} must resolve to a ${constraint.kind}.`);
  }
  if (constraint.choices && typeof checked === "string" && !constraint.choices.includes(checked)) {
    throw new Error(`${label} must be one of ${constraint.choices.join(", ")}.`);
  }
}

export function resolveCommand(node: CommandNode, input: Json, outputs: Outputs): ResolvedCommand {
  const source = node.command;
  const args = source.args.map((arg, index) => {
    const label = `Argument ${index + 1}`;
    const value = resolveValue(arg, input, outputs);
    const constraint = source.argConstraints?.[index];
    if (constraint) {
      checkConstraint(arg, value, constraint, label, input, outputs);
    }
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
