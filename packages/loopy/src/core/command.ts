import type {
  CommandArgs,
  CommandArgument,
  CommandCall,
  CommandDescriptor,
  CommandFlags,
  CommandInput,
  FlagDefinition,
  PositionalDefinition,
} from "./command-types.js";
import type { ArgConstraint, Command } from "./model.js";
import { FLAG_CLI_PATTERN } from "./names.js";

type LooseInput = CommandInput<readonly (CommandArgument | undefined)[], Record<string, unknown>>;

function assertArgument(value: unknown, location: string): asserts value is CommandArgument {
  if (typeof value === "string" || (typeof value === "number" && Number.isFinite(value))) {
    return;
  }
  if (
    value &&
    typeof value === "object" &&
    ("$ref" in value || "$op" in value || "$file" in value)
  ) {
    return;
  }
  throw new Error(`${location} must be a string, number, or workflow value.`);
}

function validatePositionalOrder(positionals: readonly PositionalDefinition[]): void {
  let optionalSeen = false;
  for (const [index, part] of positionals.entries()) {
    if (optionalSeen && !part.optional) {
      throw new Error("A required positional cannot follow an optional positional.");
    }
    if (part.variadic && index !== positionals.length - 1) {
      throw new Error("A variadic positional must be last.");
    }
    if (part.optional) {
      optionalSeen = true;
    }
  }
}

function validateFlags(flags: Readonly<Record<string, FlagDefinition>>): void {
  const entries = Object.entries(flags);
  for (const [key, flag] of entries) {
    if (!FLAG_CLI_PATTERN.test(flag.cli)) {
      throw new Error(`Flag '${key}' must be spelled like --name.`);
    }
    if (flag.attachedValue && (!flag.optionalValue || flag.kind === "boolean")) {
      throw new Error(`Flag '${key}' can only attach a value when it is an optional non-boolean.`);
    }
  }
  if (new Set(entries.map(([, flag]) => flag.cli)).size !== entries.length) {
    throw new Error("Command descriptor repeats a flag spelling.");
  }
}

function validateDescriptor(descriptor: CommandDescriptor): void {
  if (!descriptor.program.trim()) {
    throw new Error("Command descriptor needs a program.");
  }
  validatePositionalOrder(descriptor.positionals ?? []);
  validateFlags(descriptor.flags ?? {});
}

function checkArity(
  args: readonly CommandArgument[],
  positionals: readonly PositionalDefinition[],
): void {
  const required = positionals.filter((part) => !part.optional).length;
  const variadic = positionals.some((part) => part.variadic);
  if (args.length < required || (!variadic && args.length > positionals.length)) {
    const range = variadic ? `${required}+` : `${required}-${positionals.length}`;
    throw new Error(`Expected ${range} positional arguments; received ${args.length}.`);
  }
}

/** Appends one flag occurrence to argv and records the constraint its value must satisfy. */
function pushFlag(
  key: string,
  flag: FlagDefinition,
  item: unknown,
  args: CommandArgument[],
  constraints: Record<number, ArgConstraint>,
): void {
  if (flag.kind === "boolean") {
    if (item !== true) {
      throw new Error(`Flag '${key}' must be boolean.`);
    }
    args.push(flag.cli);
    return;
  }
  if (item === true && flag.optionalValue) {
    args.push(flag.cli);
    return;
  }
  if (typeof item === "boolean") {
    throw new Error(`Flag '${key}' needs a value.`);
  }
  assertArgument(item, `Flag '${key}'`);
  if (flag.kind === "number" && typeof item === "string") {
    throw new Error(`Flag '${key}' must be numeric.`);
  }
  if (flag.choices && typeof item === "string" && !flag.choices.includes(item)) {
    throw new Error(`Flag '${key}' must be one of ${flag.choices.join(", ")}.`);
  }
  const constraint: ArgConstraint = { kind: flag.kind };
  if (flag.choices) {
    constraint.choices = [...flag.choices];
  }
  if (flag.attachedValue) {
    const prefix = `${flag.cli}=`;
    constraint.prefix = prefix;
    constraints[args.length] = constraint;
    args.push({ $op: "concat", args: [prefix, item] });
    return;
  }
  args.push(flag.cli);
  constraints[args.length] = constraint;
  args.push(item);
}

function pushFlags(
  descriptor: CommandDescriptor,
  flags: Record<string, unknown>,
  args: CommandArgument[],
  constraints: Record<number, ArgConstraint>,
): void {
  for (const [key, value] of Object.entries(flags)) {
    const flag = descriptor.flags?.[key];
    if (!flag) {
      throw new Error(`Unknown flag '${key}' for ${descriptor.program}.`);
    }
    if (value === undefined || value === false) {
      continue;
    }
    const items = flag.repeatable ? value : [value];
    if (!Array.isArray(items)) {
      throw new Error(`Flag '${key}' must be an array.`);
    }
    for (const item of items) {
      pushFlag(key, flag, item, args, constraints);
    }
  }
}

/** Drops trailing omitted optionals and checks the count against the descriptor. */
function presentPositionals(
  descriptor: CommandDescriptor,
  provided: readonly (CommandArgument | undefined)[],
): CommandArgument[] {
  const positionals = provided.filter((value) => value !== undefined);
  if (provided.slice(0, positionals.length).includes(undefined)) {
    throw new Error("Cannot omit a positional before a later positional.");
  }
  if (descriptor.positionals) {
    checkArity(positionals, descriptor.positionals);
  }
  return positionals;
}

function pushPositionals(
  descriptor: CommandDescriptor,
  positionals: readonly CommandArgument[],
  args: CommandArgument[],
  constraints: Record<number, ArgConstraint>,
): void {
  if (positionals.length && descriptor.positionalSeparator !== false) {
    args.push("--");
  }
  for (const [index, value] of positionals.entries()) {
    assertArgument(value, `Argument ${index + 1}`);
    if (descriptor.positionals) {
      constraints[args.length] = { kind: "string" };
    }
    args.push(value);
  }
}

function buildCommand(descriptor: CommandDescriptor, input: LooseInput): Command {
  const args: CommandArgument[] = [...(descriptor.path ?? [])];
  const argConstraints: Record<number, ArgConstraint> = {};
  pushFlags(descriptor, input.flags ?? {}, args, argConstraints);
  pushPositionals(
    descriptor,
    presentPositionals(descriptor, input.args ?? []),
    args,
    argConstraints,
  );
  return {
    program: descriptor.program,
    args,
    argConstraints: Object.keys(argConstraints).length ? argConstraints : undefined,
    stdin: input.stdin,
    env: input.env,
    cwd: input.cwd,
    timeoutMs: input.timeoutMs,
    maxOutputBytes: input.maxOutputBytes,
  };
}

export function defineCommand<const Descriptor extends CommandDescriptor>(descriptor: Descriptor) {
  validateDescriptor(descriptor);
  const build = (input: LooseInput = {}): Command => buildCommand(descriptor, input);
  return build as CommandCall<CommandArgs<Descriptor>, CommandFlags<Descriptor>>;
}

export function command(program: string, ...args: CommandArgument[]): Command {
  if (!program.trim()) {
    throw new Error("Command needs a program.");
  }
  for (const [index, value] of args.entries()) {
    assertArgument(value, `Argument ${index + 1}`);
  }
  return { program, args };
}

/** Run an existing Bash script. Typed CLI commands should use defineCommand. */
export function bash(script: string): Command {
  return command("bash", "--noprofile", "--norc", "-e", "-o", "pipefail", "-c", script);
}
