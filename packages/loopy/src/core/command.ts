import type { ArgConstraint, Command, Value } from "./model.js";

export type CommandArgument = Value<string | number>;
export type FlagDefinition = {
  readonly cli: string;
  readonly kind: "boolean" | "string" | "number";
  readonly repeatable?: boolean;
  readonly optionalValue?: boolean;
  readonly attachedValue?: boolean;
  readonly choices?: readonly string[];
};
export type PositionalDefinition = {
  readonly name: string;
  readonly optional?: boolean;
  readonly variadic?: boolean;
};
export type CommandDescriptor = {
  readonly program: string;
  readonly path?: readonly string[];
  readonly positionalSeparator?: boolean;
  readonly positionals?: readonly PositionalDefinition[];
  readonly flags?: Readonly<Record<string, FlagDefinition>>;
  readonly helpHash?: string;
  readonly observedVersion?: string;
};

type Positionals<Parts extends readonly PositionalDefinition[]> = Parts extends readonly [
  infer First extends PositionalDefinition,
  ...infer Rest extends readonly PositionalDefinition[],
]
  ? First extends { readonly variadic: true }
    ? First extends { readonly optional: true }
      ? readonly Value<string>[]
      : readonly [Value<string>, ...Value<string>[]]
    : First extends { readonly optional: true }
      ? readonly [Value<string>?, ...Positionals<Rest>]
      : readonly [Value<string>, ...Positionals<Rest>]
  : readonly [];

export type CommandArgs<Descriptor extends CommandDescriptor> = Descriptor extends {
  readonly positionals: infer Parts extends readonly PositionalDefinition[];
}
  ? Positionals<Parts>
  : readonly CommandArgument[];

type OptionalTrue<Flag extends FlagDefinition> = Flag extends { readonly optionalValue: true }
  ? true
  : never;
type FlagValue<Flag extends FlagDefinition> = Flag["kind"] extends "boolean"
  ? boolean
  : Flag["kind"] extends "number"
    ? Value<number> | OptionalTrue<Flag>
    : Flag extends { readonly choices: infer Choices extends readonly string[] }
      ? Value<Choices[number]> | OptionalTrue<Flag>
      : Value<string> | OptionalTrue<Flag>;

export type CommandFlags<Descriptor extends CommandDescriptor> = Descriptor extends {
  readonly flags: infer Flags extends Readonly<Record<string, FlagDefinition>>;
}
  ? keyof Flags extends never
    ? Record<string, never>
    : {
        [Key in keyof Flags]: Flags[Key] extends { readonly repeatable: true }
          ? readonly FlagValue<Flags[Key]>[]
          : FlagValue<Flags[Key]>;
      }
  : Record<string, never>;

export type CommandInput<
  Args extends readonly (CommandArgument | undefined)[],
  Flags extends object,
> = (Args extends readonly []
  ? { readonly args?: Args }
  : undefined extends Args[0]
    ? { readonly args?: Args }
    : { readonly args: Args }) & {
  readonly flags?: Partial<Flags>;
  readonly stdin?: Value<string>;
  readonly env?: Record<string, Value<string>>;
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
};

type CommandCall<
  Args extends readonly (CommandArgument | undefined)[],
  Flags extends object,
> = Args extends readonly []
  ? (input?: CommandInput<Args, Flags>) => Command
  : undefined extends Args[0]
    ? (input?: CommandInput<Args, Flags>) => Command
    : (input: CommandInput<Args, Flags>) => Command;

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
  throw new Error(`${location} must be a string, number, or workflow value`);
}

function validateDescriptor(descriptor: CommandDescriptor): void {
  if (!descriptor.program.trim()) {
    throw new Error("Command descriptor needs a program");
  }
  const positionals = descriptor.positionals ?? [];
  let optionalSeen = false;
  for (const [index, part] of positionals.entries()) {
    if (optionalSeen && !part.optional) {
      throw new Error("A required positional cannot follow an optional positional");
    }
    if (part.variadic && index !== positionals.length - 1) {
      throw new Error("A variadic positional must be last");
    }
    if (part.optional) {
      optionalSeen = true;
    }
  }
  const flags = Object.entries(descriptor.flags ?? {});
  for (const [key, flag] of flags) {
    if (!/^--[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(flag.cli)) {
      throw new Error(`Flag '${key}' has an invalid CLI spelling`);
    }
    if (flag.attachedValue && (!flag.optionalValue || flag.kind === "boolean")) {
      throw new Error(`Flag '${key}' has invalid attached-value metadata`);
    }
  }
  if (new Set(flags.map(([, flag]) => flag.cli)).size !== flags.length) {
    throw new Error("Command descriptor repeats a flag");
  }
}

function checkArity(
  args: readonly CommandArgument[],
  positionals: readonly PositionalDefinition[],
): void {
  const required = positionals.filter((part) => !part.optional).length;
  const variadic = positionals.some((part) => part.variadic);
  if (args.length < required || (!variadic && args.length > positionals.length)) {
    throw new Error(
      `Expected ${required}${variadic ? "+" : `-${positionals.length}`} positional arguments; received ${args.length}`,
    );
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
      throw new Error(`Flag '${key}' must be boolean`);
    }
    args.push(flag.cli);
    return;
  }
  if (item === true && flag.optionalValue) {
    args.push(flag.cli);
    return;
  }
  if (typeof item === "boolean") {
    throw new Error(`Flag '${key}' needs a value`);
  }
  assertArgument(item, `Flag '${key}'`);
  if (flag.kind === "number" && typeof item === "string") {
    throw new Error(`Flag '${key}' must be numeric`);
  }
  if (flag.choices && typeof item === "string" && !flag.choices.includes(item)) {
    throw new Error(`Flag '${key}' must be one of ${flag.choices.join(", ")}`);
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
  } else {
    args.push(flag.cli);
    constraints[args.length] = constraint;
    args.push(item);
  }
}

export function defineCommand<const Descriptor extends CommandDescriptor>(descriptor: Descriptor) {
  validateDescriptor(descriptor);
  const build = (input: LooseInput = {}): Command => {
    const args: CommandArgument[] = [...(descriptor.path ?? [])];
    const argConstraints: Record<number, ArgConstraint> = {};
    for (const [key, value] of Object.entries(input.flags ?? {})) {
      const flag = descriptor.flags?.[key];
      if (!flag) {
        throw new Error(`Unknown flag '${key}' for ${descriptor.program}`);
      }
      if (value === undefined || value === false) {
        continue;
      }
      const items = flag.repeatable ? value : [value];
      if (!Array.isArray(items)) {
        throw new Error(`Flag '${key}' must be an array`);
      }
      for (const item of items) {
        pushFlag(key, flag, item, args, argConstraints);
      }
    }
    const provided = input.args ?? [];
    const positionals = provided.filter((value) => value !== undefined);
    if (provided.slice(0, positionals.length).includes(undefined)) {
      throw new Error("Cannot omit a positional before a later positional");
    }
    if (descriptor.positionals) {
      checkArity(positionals, descriptor.positionals);
    }
    if (positionals.length && descriptor.positionalSeparator !== false) {
      args.push("--");
    }
    for (const [index, value] of positionals.entries()) {
      assertArgument(value, `Argument ${index + 1}`);
      if (descriptor.positionals) {
        argConstraints[args.length] = { kind: "string" };
      }
      args.push(value);
    }
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
  };
  return build as CommandCall<CommandArgs<Descriptor>, CommandFlags<Descriptor>>;
}

export function command(program: string, ...args: CommandArgument[]): Command {
  if (!program.trim()) {
    throw new Error("Command needs a program");
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
