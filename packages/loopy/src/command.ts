import type { Command, Value } from "./model";

export type CommandArgument = Value<string | number>;
export type FlagDefinition = {
  readonly cli: string;
  readonly kind: "boolean" | "string" | "number";
  readonly repeatable?: boolean;
  readonly optionalValue?: boolean;
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
  readonly positionals?: readonly PositionalDefinition[];
  readonly flags?: Readonly<Record<string, FlagDefinition>>;
  readonly helpHash?: string;
  readonly observedVersion?: string;
};
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
type FlagValue<Flag extends FlagDefinition> = Flag["kind"] extends "boolean"
  ? boolean
  : Flag["kind"] extends "number"
    ? Value<number> | (Flag extends { readonly optionalValue: true } ? true : never)
    : Flag extends { readonly choices: infer Choices extends readonly string[] }
      ? Value<Choices[number]> | (Flag extends { readonly optionalValue: true } ? true : never)
      : Value<string> | (Flag extends { readonly optionalValue: true } ? true : never);
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
type CommandCall<
  Args extends readonly (CommandArgument | undefined)[],
  Flags extends object,
> = Args extends readonly []
  ? (input?: CommandInput<Args, Flags>) => Command
  : undefined extends Args[0]
    ? (input?: CommandInput<Args, Flags>) => Command
    : (input: CommandInput<Args, Flags>) => Command;

function argument(value: unknown, location: string): asserts value is CommandArgument {
  if (typeof value === "string" || (typeof value === "number" && Number.isFinite(value))) return;
  if (value && typeof value === "object" && ("$ref" in value || "$op" in value)) return;
  throw new Error(`${location} must be a string, number, or workflow value`);
}

function validateDescriptor(descriptor: CommandDescriptor): void {
  if (!descriptor.program.trim()) throw new Error("Command descriptor needs a program");
  let optionalSeen = false;
  for (const [index, part] of (descriptor.positionals ?? []).entries()) {
    if (optionalSeen && !part.optional)
      throw new Error("A required positional cannot follow an optional positional");
    if (part.variadic && index !== (descriptor.positionals?.length ?? 0) - 1)
      throw new Error("A variadic positional must be last");
    if (part.optional) optionalSeen = true;
  }
  for (const [key, flag] of Object.entries(descriptor.flags ?? {})) {
    if (!/^--[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(flag.cli))
      throw new Error(`Flag '${key}' has an invalid CLI spelling`);
  }
  const names = Object.values(descriptor.flags ?? {}).map((flag) => flag.cli);
  if (new Set(names).size !== names.length) throw new Error("Command descriptor repeats a flag");
}

function validateArity(
  args: readonly CommandArgument[],
  positionals: readonly PositionalDefinition[],
) {
  const required = positionals.filter((part) => !part.optional).length;
  const variadic = positionals.some((part) => part.variadic);
  if (args.length < required || (!variadic && args.length > positionals.length))
    throw new Error(
      `Expected ${required}${variadic ? "+" : `-${positionals.length}`} positional arguments; received ${args.length}`,
    );
}

export function defineCommand<const Descriptor extends CommandDescriptor>(descriptor: Descriptor) {
  validateDescriptor(descriptor);
  const build = (
    input: CommandInput<readonly (CommandArgument | undefined)[], Record<string, unknown>> = {},
  ): Command => {
    const provided = input.args ?? [];
    if (descriptor.positionals)
      validateArity(
        provided.filter((value) => value !== undefined),
        descriptor.positionals,
      );
    const args: CommandArgument[] = [...(descriptor.path ?? [])];
    for (const [key, value] of Object.entries(input.flags ?? {})) {
      const flag = descriptor.flags?.[key];
      if (!flag) throw new Error(`Unknown flag '${key}' for ${descriptor.program}`);
      if (value === undefined || value === false) continue;
      const values = flag.repeatable ? value : [value];
      if (!Array.isArray(values)) throw new Error(`Flag '${key}' must be an array`);
      for (const item of values) {
        if (flag.kind === "boolean") {
          if (item !== true) throw new Error(`Flag '${key}' must be boolean`);
          args.push(flag.cli);
        } else {
          if (item === true && flag.optionalValue) {
            args.push(flag.cli);
            continue;
          }
          if (typeof item === "boolean") throw new Error(`Flag '${key}' needs a value`);
          argument(item, `Flag '${key}'`);
          if (flag.kind === "number" && typeof item === "string")
            throw new Error(`Flag '${key}' must be numeric`);
          if (flag.choices && typeof item === "string" && !flag.choices.includes(item))
            throw new Error(`Flag '${key}' must be one of ${flag.choices.join(", ")}`);
          args.push(flag.cli, item);
        }
      }
    }
    for (const [index, value] of provided.entries()) {
      if (value === undefined) continue;
      argument(value, `Argument ${index + 1}`);
      args.push(value);
    }
    return {
      program: descriptor.program,
      args,
      ...(input.stdin !== undefined ? { stdin: input.stdin } : {}),
      ...(input.env ? { env: input.env } : {}),
      ...(input.cwd ? { cwd: input.cwd } : {}),
      ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
      ...(input.maxOutputBytes ? { maxOutputBytes: input.maxOutputBytes } : {}),
    };
  };
  return build as CommandCall<CommandArgs<Descriptor>, CommandFlags<Descriptor>>;
}

export function command(program: string, ...args: CommandArgument[]): Command {
  if (!program.trim()) throw new Error("Command needs a program");
  for (const [index, value] of args.entries()) argument(value, `Argument ${index + 1}`);
  return { program, args };
}

/** Run an existing Bash script. Typed CLI commands should use defineCommand. */
export function bash(script: string): Command {
  return command("bash", "--noprofile", "--norc", "-e", "-o", "pipefail", "-c", script);
}
