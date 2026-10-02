import type {
  Command,
  CommandNode,
  CommandOutput,
  ConditionNode,
  Expression,
  FilePath,
  Operator,
  Reference,
  ReferenceSource,
  Scalar,
  Value,
  Workflow,
  WorkflowConfig,
  WorkflowNode,
} from "./model.js";

type Refs<T> = { readonly [K in keyof T]: Reference<T[K]> };
export type WorkflowContext<Input, Steps> = {
  readonly input: Refs<Input>;
  readonly steps: { readonly [K in keyof Steps]: Refs<Steps[K]> };
};

/** A literal value, or a callback that builds one from typed references. */
type Author<Input, Steps, T> = T | ((context: WorkflowContext<Input, Steps>) => T);
type Branch = WorkflowNode | readonly WorkflowNode[];

function reference<T>(source: ReferenceSource, path: string[]): Reference<T> {
  return { $ref: { source, path } };
}

/** Lazily builds references: `input.x` is one level deep, `steps.id.field` is two. */
function referenceTree<T>(source: ReferenceSource, path: string[] = []): T {
  return new Proxy(Object.create(null) as T & object, {
    get(_target, key) {
      if (typeof key !== "string") return undefined;
      const next = [...path, key];
      if (source === "steps" && path.length === 0) return referenceTree(source, next);
      return reference(source, next);
    },
  });
}

function context<Input, Steps>(): WorkflowContext<Input, Steps> {
  return { input: referenceTree("input"), steps: referenceTree("steps") };
}

function author<Input, Steps, T>(value: Author<Input, Steps, T>): T {
  return typeof value === "function"
    ? (value as (context: WorkflowContext<Input, Steps>) => T)(context())
    : value;
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

export function file(path: string): FilePath {
  if (!path.trim()) throw new Error("File path is required");
  return { $file: path };
}

export function node(id: string, command: Command): CommandNode {
  return { id, kind: "command", command };
}

function nodeList(branch: Branch): WorkflowNode[] {
  return "kind" in branch ? [branch] : [...branch];
}

export class WorkflowBuilder<Input, Steps = Record<never, never>> {
  constructor(
    readonly slug: string,
    private readonly nodes: readonly WorkflowNode[] = [],
    private readonly summary?: string,
    private readonly settings?: WorkflowConfig,
  ) {}

  description(text: string): WorkflowBuilder<Input, Steps> {
    return new WorkflowBuilder(this.slug, this.nodes, text, this.settings);
  }

  config(settings: WorkflowConfig): WorkflowBuilder<Input, Steps> {
    return new WorkflowBuilder(this.slug, this.nodes, this.summary, settings);
  }

  node<const Id extends string>(
    id: Id,
    command: Author<Input, Steps, Command>,
  ): WorkflowBuilder<Input, Steps & Record<Id, CommandOutput>> {
    return new WorkflowBuilder(
      this.slug,
      [...this.nodes, node(id, author(command))],
      this.summary,
      this.settings,
    );
  }

  condition<const Id extends string>(
    id: Id,
    test: Author<Input, Steps, Value<boolean>>,
    thenBranch: Author<Input, Steps, Branch>,
    elseBranch: Author<Input, Steps, Branch>,
  ): WorkflowBuilder<Input, Steps & Record<Id, { branch: "then" | "else" }>> {
    const condition: ConditionNode = {
      id,
      kind: "condition",
      test: author(test),
      // biome-ignore lint/suspicious/noThenProperty: This is the persisted condition branch key.
      then: nodeList(author(thenBranch)),
      else: nodeList(author(elseBranch)),
    };
    return new WorkflowBuilder(this.slug, [...this.nodes, condition], this.summary, this.settings);
  }

  build(): Workflow {
    return compileWorkflow({
      version: 1,
      slug: this.slug,
      description: this.summary,
      config: this.settings,
      nodes: [...this.nodes],
    });
  }
}

export function trigger<Input = Record<string, never>>(slug: string): WorkflowBuilder<Input> {
  return new WorkflowBuilder<Input>(slug);
}

const idPattern = /^[a-z][a-z0-9_-]*$/;
const slugPattern = /^[a-z0-9][a-z0-9-]{0,79}$/;
const envKeyPattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
const indexPattern = /^(0|[1-9][0-9]*)$/;
const maxDepth = 32;
const arity: Record<Operator, number | "variadic"> = {
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

function requireRecord(value: unknown, location: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${location} must be an object`);
  return value as Record<string, unknown>;
}

function allowKeys(value: Record<string, unknown>, location: string, allowed: string[]): void {
  for (const key of Object.keys(value))
    if (!allowed.includes(key)) throw new Error(`${location} has an unsupported field '${key}'`);
}

function validateReference(ref: unknown, location: string, visible: ReadonlySet<string>): void {
  const record = requireRecord(ref, location);
  allowKeys(record, location, ["source", "path"]);
  if (record.source !== "input" && record.source !== "steps")
    throw new Error(`${location} has an invalid reference source`);
  const path = record.path;
  const minimum = record.source === "steps" ? 2 : 1;
  if (
    !Array.isArray(path) ||
    path.length < minimum ||
    !path.every((p) => typeof p === "string" && p)
  )
    throw new Error(`${location} has an invalid reference path`);
  if (record.source === "steps" && !visible.has(path[0] as string))
    throw new Error(`${location} references a step that is not available yet: ${path[0]}`);
}

/** Accepts a JSON scalar, a reference to visible data, or an expression over those. */
function validateValue(
  value: unknown,
  location: string,
  visible: ReadonlySet<string>,
  depth = 0,
): void {
  if (depth > maxDepth) throw new Error(`${location} is too deeply nested`);
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  const invalid = new Error(`${location} must be a literal, reference, or expression`);
  if (typeof value !== "object" || Array.isArray(value)) throw invalid;
  const item = value as Record<string, unknown>;
  if ("$file" in item) {
    allowKeys(item, location, ["$file"]);
    if (typeof item.$file !== "string" || !item.$file.trim())
      throw new Error(`${location} has an invalid file path`);
    return;
  }
  if ("$ref" in item) {
    allowKeys(item, location, ["$ref"]);
    validateReference(item.$ref, `${location}.$ref`, visible);
    return;
  }
  if (!("$op" in item)) throw invalid;
  allowKeys(item, location, ["$op", "args"]);
  const expected = arity[item.$op as Operator];
  if (!expected || !Array.isArray(item.args))
    throw new Error(`${location} has an invalid expression`);
  if (expected === "variadic" ? item.args.length < 1 : item.args.length !== expected)
    throw new Error(`${location} has the wrong number of operands`);
  for (const [index, arg] of item.args.entries())
    validateValue(arg, `${location}.args[${index}]`, visible, depth + 1);
}

function validateArgConstraints(raw: unknown, args: unknown[], command: string): void {
  const location = `${command}.argConstraints`;
  const constraints = requireRecord(raw, location);
  for (const [index, value] of Object.entries(constraints)) {
    const here = `${location}.${index}`;
    if (!indexPattern.test(index) || Number(index) >= args.length)
      throw new Error(`${location} has an invalid argument index '${index}'`);
    const constraint = requireRecord(value, here);
    allowKeys(constraint, here, ["kind", "choices", "prefix"]);
    if (constraint.kind !== "string" && constraint.kind !== "number")
      throw new Error(`${here}.kind is invalid`);
    const { choices, prefix } = constraint;
    if (
      choices !== undefined &&
      (constraint.kind !== "string" ||
        !Array.isArray(choices) ||
        !choices.length ||
        !choices.every((choice) => typeof choice === "string"))
    )
      throw new Error(`${here}.choices is invalid`);
    if (prefix === undefined) continue;
    if (typeof prefix !== "string" || !prefix) throw new Error(`${here}.prefix is invalid`);
    // An attached flag must be stored as concat(prefix, value) so the runtime can check the value alone.
    const attached = requireRecord(args[Number(index)], `${command}.args[${index}]`);
    if (
      attached.$op !== "concat" ||
      !Array.isArray(attached.args) ||
      attached.args.length !== 2 ||
      attached.args[0] !== prefix
    )
      throw new Error(`${here} has no matching value`);
  }
}

function validateCommand(raw: unknown, location: string, visible: ReadonlySet<string>): void {
  const command = requireRecord(raw, location);
  allowKeys(command, location, [
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
    throw new Error(`${location}.program is required`);
  if (!Array.isArray(command.args)) throw new Error(`${location}.args must be an array`);
  for (const [index, arg] of command.args.entries())
    validateValue(arg, `${location}.args[${index}]`, visible);
  if (command.argConstraints !== undefined)
    validateArgConstraints(command.argConstraints, command.args, location);
  if (command.stdin !== undefined) validateValue(command.stdin, `${location}.stdin`, visible);
  if (command.env !== undefined) {
    for (const [key, value] of Object.entries(requireRecord(command.env, `${location}.env`))) {
      if (!envKeyPattern.test(key)) throw new Error(`Invalid environment key '${key}'`);
      validateValue(value, `${location}.env.${key}`, visible);
    }
  }
  if (command.cwd !== undefined && typeof command.cwd !== "string")
    throw new Error(`${location}.cwd must be a string`);
  for (const key of ["timeoutMs", "maxOutputBytes"] as const) {
    const limit = command[key];
    if (limit !== undefined && (!Number.isSafeInteger(limit) || (limit as number) < 1))
      throw new Error(`${location}.${key} must be a positive integer`);
  }
}

/**
 * Walks one node list. `ids` is shared across the whole graph so ids stay unique;
 * `visible` is copied per branch so branch-local outputs stay out of reach afterwards.
 */
function validateNodes(
  nodes: unknown,
  ids: Set<string>,
  visible: Set<string>,
  location: string,
  depth = 0,
): void {
  if (depth > maxDepth) throw new Error("Workflow branches are too deeply nested");
  if (!Array.isArray(nodes) || nodes.length === 0) throw new Error(`${location} must have nodes`);
  for (const [index, raw] of nodes.entries()) {
    const path = `${location}[${index}]`;
    const item = requireRecord(raw, path);
    if (typeof item.id !== "string" || !idPattern.test(item.id))
      throw new Error(`${path}.id must start with a letter and contain letters, numbers, _ or -`);
    if (ids.has(item.id)) throw new Error(`Duplicate workflow node id '${item.id}'`);
    ids.add(item.id);
    if (item.kind === "command") {
      allowKeys(item, path, ["id", "kind", "command"]);
      validateCommand(item.command, `${path}.command`, visible);
      visible.add(item.id);
    } else if (item.kind === "condition") {
      allowKeys(item, path, ["id", "kind", "test", "then", "else"]);
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
  allowKeys(workflow, "Workflow", ["version", "slug", "description", "config", "nodes"]);
  if (workflow.version !== 1) throw new Error("Unsupported workflow version");
  if (typeof workflow.slug !== "string" || !slugPattern.test(workflow.slug))
    throw new Error("Workflow slug must use lowercase letters, numbers and hyphens");
  if (workflow.description !== undefined && typeof workflow.description !== "string")
    throw new Error("Workflow description must be a string");
  if (workflow.config !== undefined) {
    const config = requireRecord(workflow.config, "Workflow.config");
    allowKeys(config, "Workflow.config", ["scope"]);
    if (config.scope !== "project" && config.scope !== "global")
      throw new Error("Workflow.config.scope must be project or global");
  }
  validateNodes(workflow.nodes, new Set(), new Set(), "Workflow.nodes");
}

/** Accepts a built graph or any builder, including one from another copy of this package. */
export function compileWorkflow(input: Workflow | { build(): Workflow }): Workflow {
  const workflow = "build" in input && typeof input.build === "function" ? input.build() : input;
  validateWorkflow(workflow);
  return JSON.parse(JSON.stringify(workflow)) as Workflow;
}
