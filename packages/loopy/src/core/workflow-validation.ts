import type { Workflow } from "./model.js";
import {
  ARRAY_INDEX_PATTERN,
  validateEnvironmentName,
  validateNodeId,
  validateSlug,
} from "./names.js";
import {
  allowKeys,
  isRecord,
  isStringArray,
  requireNonEmptyString,
  requireOneOf,
  requirePositiveInteger,
  requireRecord,
  requireString,
} from "./validation.js";
import { MAX_DEPTH, validateValue } from "./value-validation.js";

/** An attached flag is stored as concat(prefix, value) so the runtime can check the value alone. */
// BOUNDARY: Imported workflow operands must encode the descriptor prefix and exactly one value.
function validateAttachedPrefix(arg: unknown, prefix: string, location: string): void {
  const attached = requireRecord(arg, location);
  const operands = attached.args;

  if (
    attached.$op !== "concat" ||
    !Array.isArray(operands) ||
    operands.length !== 2 ||
    operands[0] !== prefix
  ) {
    throw new Error(`${location} has no matching value for prefix '${prefix}'.`);
  }
}

// BOUNDARY: Imported workflow constraints must provide a known kind and valid choices and attached prefix.
function validateArgConstraint(raw: unknown, arg: unknown, location: string): void {
  const constraint = requireRecord(raw, location);
  allowKeys(constraint, location, ["kind", "choices", "prefix"]);
  const kind = requireOneOf(constraint.kind, ["string", "number"], `${location}.kind`);
  const { choices, prefix } = constraint;

  if (choices !== undefined && (kind !== "string" || !isStringArray(choices) || !choices.length)) {
    throw new Error(`${location}.choices must be a non-empty list of strings on a string arg.`);
  }

  if (prefix === undefined) {
    return;
  }

  validateAttachedPrefix(arg, requireNonEmptyString(prefix, `${location}.prefix`), location);
}

// BOUNDARY: Imported workflow constraint keys must index existing arguments and each constraint is checked.
function validateArgConstraints(raw: unknown, args: unknown[], command: string): void {
  const location = `${command}.argConstraints`;
  const constraints = requireRecord(raw, location);

  for (const [index, constraint] of Object.entries(constraints)) {
    if (!ARRAY_INDEX_PATTERN.test(index) || Number(index) >= args.length) {
      throw new Error(`${location} has an invalid argument index '${index}'.`);
    }

    validateArgConstraint(constraint, args[Number(index)], `${location}.${index}`);
  }
}

// BOUNDARY: Imported workflow environment keys and all value operands are checked before execution.
function validateEnv(raw: unknown, location: string, visible: ReadonlySet<string>): void {
  for (const [key, value] of Object.entries(requireRecord(raw, location))) {
    validateEnvironmentName(key);
    validateValue(value, `${location}.${key}`, visible);
  }
}

// BOUNDARY: Imported workflow command fields are checked for program, argument operands, environment and resource limits.
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
  requireNonEmptyString(command.program, `${location}.program`);

  if (!Array.isArray(command.args)) {
    throw new Error(`${location}.args must be an array.`);
  }

  for (const [index, arg] of command.args.entries()) {
    validateValue(arg, `${location}.args[${index}]`, visible);
  }

  if (command.argConstraints !== undefined) {
    validateArgConstraints(command.argConstraints, command.args, location);
  }

  if (command.stdin !== undefined) {
    validateValue(command.stdin, `${location}.stdin`, visible);
  }

  if (command.env !== undefined) {
    validateEnv(command.env, `${location}.env`, visible);
  }

  if (command.cwd !== undefined) {
    requireString(command.cwd, `${location}.cwd`);
  }

  for (const key of ["timeoutMs", "maxOutputBytes"] as const) {
    if (command[key] !== undefined) {
      requirePositiveInteger(command[key], `${location}.${key}`);
    }
  }
}

// BOUNDARY: Imported workflow nodes are checked for unique IDs, known kinds and their command or branch schema.
function validateNode(
  raw: unknown,
  path: string,
  ids: Set<string>,
  visible: Set<string>,
  depth: number,
): void {
  const item = requireRecord(raw, path);
  const id = requireString(item.id, `${path}.id`);
  validateNodeId(id, `${path}.id`);

  if (ids.has(id)) {
    throw new Error(`Duplicate workflow node id '${id}'.`);
  }

  ids.add(id);
  const kind = requireOneOf(item.kind, ["command", "condition"], `${path}.kind`);

  if (kind === "command") {
    allowKeys(item, path, ["id", "kind", "command"]);
    validateCommand(item.command, `${path}.command`, visible);
    visible.add(id);

    return;
  }

  allowKeys(item, path, ["id", "kind", "test", "then", "else"]);
  validateValue(item.test, `${path}.test`, visible);
  visible.add(id);
  validateNodes(item.then, ids, new Set(visible), `${path}.then`, depth + 1);
  validateNodes(item.else, ids, new Set(visible), `${path}.else`, depth + 1);
}

/**
 * Walks one node list. `ids` is shared across the whole graph so ids stay unique;
 * `visible` is copied per branch so branch-local outputs stay out of reach afterwards.
 */
// BOUNDARY: Imported workflow branches must contain nodes within the depth limit and each node is checked.
function validateNodes(
  nodes: unknown,
  ids: Set<string>,
  visible: Set<string>,
  location: string,
  depth = 0,
): void {
  if (depth > MAX_DEPTH) {
    throw new Error("Workflow branches are too deeply nested.");
  }

  if (!Array.isArray(nodes) || nodes.length === 0) {
    throw new Error(`${location} must have at least one node.`);
  }

  for (const [index, raw] of nodes.entries()) {
    validateNode(raw, `${location}[${index}]`, ids, visible, depth);
  }
}

// BOUNDARY: Imported workflow configuration accepts only the project or global scope.
function validateConfig(raw: unknown): void {
  const config = requireRecord(raw, "Workflow.config");
  allowKeys(config, "Workflow.config", ["scope"]);
  requireOneOf(config.scope, ["project", "global"], "Workflow.config.scope");
}

export function validateWorkflow(value: unknown): asserts value is Workflow {
  const workflow = requireRecord(value, "Workflow");
  allowKeys(workflow, "Workflow", ["version", "slug", "description", "config", "nodes"]);

  if (workflow.version !== 1) {
    throw new Error("Workflow.version must be 1.");
  }

  validateSlug(requireString(workflow.slug, "Workflow.slug"));

  if (workflow.description !== undefined) {
    requireString(workflow.description, "Workflow.description");
  }

  if (workflow.config !== undefined) {
    validateConfig(workflow.config);
  }

  validateNodes(workflow.nodes, new Set(), new Set(), "Workflow.nodes");
}

/** Accepts a built graph or any builder, including one from another copy of this package. */
// BOUNDARY: An imported module may expose a builder; its result or exported graph is validated before copying.
export function compileWorkflow(input: unknown): Workflow {
  // BOUNDARY: The imported module builder is invoked only when build is callable; its graph is validated immediately below.
  const workflow = isRecord(input) && typeof input.build === "function" ? input.build() : input;
  validateWorkflow(workflow);

  const copied: unknown = JSON.parse(JSON.stringify(workflow));
  validateWorkflow(copied);

  return copied;
}
