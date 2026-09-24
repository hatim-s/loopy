import type {
  Command,
  CommandNode,
  CommandOutput,
  ConditionNode,
  Expression,
  Reference,
  Scalar,
  Value,
  Workflow,
  WorkflowNode,
} from "./model";

type Refs<T> = { readonly [K in keyof T]: Reference<T[K]> };
export type WorkflowContext<Input, Steps> = {
  readonly input: Refs<Input>;
  readonly steps: { readonly [K in keyof Steps]: Refs<Steps[K]> };
};

type Author<Input, Steps, T> = T | ((context: WorkflowContext<Input, Steps>) => T);

function reference<T>(source: "input" | "steps", path: string[]): Reference<T> {
  return { $ref: { source, path } };
}

function referenceTree<T>(source: "input" | "steps", path: string[] = []): T {
  return new Proxy(Object.create(null) as T & object, {
    get(_target, key) {
      if (typeof key !== "string") return undefined;
      const next = [...path, key];
      if (source === "steps" && path.length === 0) return referenceTree(source, next);
      return reference(source, next);
    },
  });
}

export function at<Item>(source: Reference<readonly Item[]>, index: number): Reference<Item>;
export function at<T, Key extends keyof T & string>(
  source: Reference<T>,
  key: Key,
): Reference<T[Key]>;
export function at(source: Reference<unknown>, key: string | number): Reference<unknown> {
  if (typeof key === "number" && (!Number.isSafeInteger(key) || key < 0))
    throw new Error("Array reference index must be a nonnegative integer");
  return reference(source.$ref.source, [...source.$ref.path, String(key)]);
}

function context<Input, Steps>(): WorkflowContext<Input, Steps> {
  return {
    input: referenceTree("input"),
    steps: referenceTree("steps"),
  };
}

function expression<T>(op: Expression<T>["$op"], ...args: unknown[]): Expression<T> {
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

export function node(id: string, command: Command): CommandNode {
  return { id, kind: "command", command };
}

export class WorkflowBuilder<Input, Steps = Record<never, never>> {
  constructor(
    readonly slug: string,
    private readonly nodes: readonly WorkflowNode[] = [],
    private readonly descriptionValue?: string,
  ) {}

  description(description: string): WorkflowBuilder<Input, Steps> {
    return new WorkflowBuilder(this.slug, this.nodes, description);
  }

  node<const Id extends string>(
    id: Id,
    command: Author<Input, Steps, Command>,
  ): WorkflowBuilder<Input, Steps & Record<Id, CommandOutput>> {
    const value = typeof command === "function" ? command(context<Input, Steps>()) : command;
    return new WorkflowBuilder<Input, Steps & Record<Id, CommandOutput>>(
      this.slug,
      [...this.nodes, node(id, value)],
      this.descriptionValue,
    );
  }

  condition<const Id extends string>(
    id: Id,
    test: Author<Input, Steps, Value<boolean>>,
    thenBranch: Author<Input, Steps, WorkflowNode | readonly WorkflowNode[]>,
    elseBranch: Author<Input, Steps, WorkflowNode | readonly WorkflowNode[]>,
  ): WorkflowBuilder<Input, Steps & Record<Id, { branch: "then" | "else" }>> {
    const value = typeof test === "function" ? test(context<Input, Steps>()) : test;
    const thenValue =
      typeof thenBranch === "function" ? thenBranch(context<Input, Steps>()) : thenBranch;
    const elseValue =
      typeof elseBranch === "function" ? elseBranch(context<Input, Steps>()) : elseBranch;
    const condition: ConditionNode = {
      id,
      kind: "condition",
      test: value,
      // biome-ignore lint/suspicious/noThenProperty: This is the persisted condition branch key.
      then: Array.isArray(thenValue) ? [...thenValue] : [thenValue as WorkflowNode],
      else: Array.isArray(elseValue) ? [...elseValue] : [elseValue as WorkflowNode],
    };
    return new WorkflowBuilder<Input, Steps & Record<Id, { branch: "then" | "else" }>>(
      this.slug,
      [...this.nodes, condition],
      this.descriptionValue,
    );
  }

  build(): Workflow {
    return compileWorkflow({
      version: 1,
      slug: this.slug,
      ...(this.descriptionValue ? { description: this.descriptionValue } : {}),
      nodes: [...this.nodes],
    });
  }
}

export function trigger<Input = Record<string, never>>(slug: string): WorkflowBuilder<Input> {
  return new WorkflowBuilder<Input>(slug);
}

const idPattern = /^[a-z][a-z0-9_-]*$/;
const slugPattern = /^[a-z0-9][a-z0-9-]{0,79}$/;
const operations: Record<Expression["$op"], number | "variadic"> = {
  eq: 2,
  ne: 2,
  gt: 2,
  gte: 2,
  lt: 2,
  lte: 2,
  and: "variadic",
  or: "variadic",
  not: 1,
  contains: 2,
  concat: "variadic",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireRecord(value: unknown, location: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${location} must be an object`);
  return value;
}

function knownKeys(
  value: Record<string, unknown>,
  location: string,
  allowed: readonly string[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`${location} has an unsupported field '${key}'`);
  }
}

function validateValue(
  value: unknown,
  location: string,
  visible: ReadonlySet<string>,
  depth = 0,
): void {
  if (depth > 32) throw new Error(`${location} is too deeply nested`);
  if (value === null || ["string", "boolean"].includes(typeof value)) return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (typeof value === "function")
    throw new Error(`${location} must be a literal, reference, or expression`);
  const item = requireRecord(value, location);
  if ("$ref" in item) {
    if (Object.keys(item).some((key) => key !== "$ref"))
      throw new Error(`${location} has unsupported reference fields`);
    const ref = requireRecord(item.$ref, `${location}.$ref`);
    knownKeys(ref, `${location}.$ref`, ["source", "path"]);
    if (ref.source !== "input" && ref.source !== "steps")
      throw new Error(`${location} has an invalid reference source`);
    if (!Array.isArray(ref.path) || ref.path.length < (ref.source === "steps" ? 2 : 1))
      throw new Error(`${location} has an invalid reference path`);
    if (ref.path.some((part) => typeof part !== "string" || !part))
      throw new Error(`${location} has an invalid reference path`);
    if (ref.source === "steps" && !visible.has(ref.path[0] as string))
      throw new Error(`${location} references a step that is not available yet: ${ref.path[0]}`);
    return;
  }
  if ("$op" in item) {
    if (Object.keys(item).some((key) => key !== "$op" && key !== "args"))
      throw new Error(`${location} has unsupported expression fields`);
    const arity = operations[item.$op as Expression["$op"]];
    if (!arity || !Array.isArray(item.args))
      throw new Error(`${location} has an invalid expression`);
    if (arity === "variadic" ? item.args.length < 1 : item.args.length !== arity)
      throw new Error(`${location} has the wrong number of operands`);
    for (const [index, arg] of item.args.entries())
      validateValue(arg, `${location}.args[${index}]`, visible, depth + 1);
    return;
  }
  throw new Error(`${location} must be a literal, reference, or expression`);
}

function validateNodes(
  nodes: unknown,
  ids: Set<string>,
  visible: Set<string>,
  location: string,
  depth = 0,
): void {
  if (depth > 32) throw new Error("Workflow branches are too deeply nested");
  if (!Array.isArray(nodes) || nodes.length === 0) throw new Error(`${location} must have nodes`);
  for (let index = 0; index < nodes.length; index += 1) {
    const path = `${location}[${index}]`;
    const item = requireRecord(nodes[index], path);
    if (typeof item.id !== "string" || !idPattern.test(item.id))
      throw new Error(`${path}.id must start with a letter and contain letters, numbers, _ or -`);
    if (ids.has(item.id)) throw new Error(`Duplicate workflow node id '${item.id}'`);
    ids.add(item.id);
    if (item.kind === "command") {
      knownKeys(item, path, ["id", "kind", "command"]);
      const command = requireRecord(item.command, `${path}.command`);
      knownKeys(command, `${path}.command`, [
        "program",
        "args",
        "argConstraints",
        "stdin",
        "env",
        "cwd",
        "timeoutMs",
        "maxOutputBytes",
      ]);
      if (typeof command.program !== "string" || !command.program.trim())
        throw new Error(`${path}.command.program is required`);
      if (!Array.isArray(command.args)) throw new Error(`${path}.command.args must be an array`);
      for (const [argIndex, arg] of command.args.entries())
        validateValue(arg, `${path}.command.args[${argIndex}]`, visible);
      if (command.argConstraints !== undefined) {
        const constraints = requireRecord(command.argConstraints, `${path}.command.argConstraints`);
        for (const [index, raw] of Object.entries(constraints)) {
          if (!/^(0|[1-9][0-9]*)$/.test(index) || Number(index) >= command.args.length)
            throw new Error(
              `${path}.command.argConstraints has an invalid argument index '${index}'`,
            );
          const constraint = requireRecord(raw, `${path}.command.argConstraints.${index}`);
          knownKeys(constraint, `${path}.command.argConstraints.${index}`, [
            "kind",
            "choices",
            "prefix",
          ]);
          if (constraint.kind !== "string" && constraint.kind !== "number")
            throw new Error(`${path}.command.argConstraints.${index}.kind is invalid`);
          if (
            constraint.choices !== undefined &&
            (!Array.isArray(constraint.choices) ||
              !constraint.choices.length ||
              constraint.choices.some((choice) => typeof choice !== "string") ||
              constraint.kind !== "string")
          )
            throw new Error(`${path}.command.argConstraints.${index}.choices is invalid`);
          if (
            constraint.prefix !== undefined &&
            (typeof constraint.prefix !== "string" || !constraint.prefix)
          )
            throw new Error(`${path}.command.argConstraints.${index}.prefix is invalid`);
          if (constraint.prefix !== undefined) {
            const attached = requireRecord(
              command.args[Number(index)],
              `${path}.command.args[${index}]`,
            );
            if (
              attached.$op !== "concat" ||
              !Array.isArray(attached.args) ||
              attached.args.length !== 2 ||
              attached.args[0] !== constraint.prefix
            )
              throw new Error(`${path}.command.argConstraints.${index} has no matching value`);
          }
        }
      }
      if (command.stdin !== undefined)
        validateValue(command.stdin, `${path}.command.stdin`, visible);
      if (command.env !== undefined) {
        const env = requireRecord(command.env, `${path}.command.env`);
        for (const [key, value] of Object.entries(env)) {
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
            throw new Error(`Invalid environment key '${key}'`);
          validateValue(value, `${path}.command.env.${key}`, visible);
        }
      }
      if (command.cwd !== undefined && typeof command.cwd !== "string")
        throw new Error(`${path}.command.cwd must be a string`);
      for (const key of ["timeoutMs", "maxOutputBytes"] as const) {
        if (
          command[key] !== undefined &&
          (!Number.isSafeInteger(command[key]) || Number(command[key]) < 1)
        )
          throw new Error(`${path}.command.${key} must be a positive integer`);
      }
      visible.add(item.id);
    } else if (item.kind === "condition") {
      knownKeys(item, path, ["id", "kind", "test", "then", "else"]);
      validateValue(item.test, `${path}.test`, visible);
      visible.add(item.id);
      validateNodes(item.then, ids, new Set(visible), `${path}.then`, depth + 1);
      validateNodes(item.else, ids, new Set(visible), `${path}.else`, depth + 1);
    } else {
      throw new Error(`${path}.kind is invalid`);
    }
  }
}

export function validateWorkflow(value: unknown): asserts value is Workflow {
  const workflow = requireRecord(value, "Workflow");
  knownKeys(workflow, "Workflow", ["version", "slug", "description", "nodes"]);
  if (workflow.version !== 1) throw new Error("Unsupported workflow version");
  if (typeof workflow.slug !== "string" || !slugPattern.test(workflow.slug))
    throw new Error("Workflow slug must use lowercase letters, numbers and hyphens");
  if (workflow.description !== undefined && typeof workflow.description !== "string")
    throw new Error("Workflow description must be a string");
  validateNodes(workflow.nodes, new Set(), new Set(), "Workflow.nodes");
  try {
    JSON.stringify(workflow);
  } catch {
    throw new Error("Workflow must be serializable as JSON");
  }
}

export function compileWorkflow(input: Workflow | { build(): Workflow }): Workflow {
  const workflow =
    input && typeof input === "object" && "build" in input && typeof input.build === "function"
      ? input.build()
      : input;
  validateWorkflow(workflow);
  return structuredClone(workflow);
}
