import type { Command, Value } from "./model.js";

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

export type CommandCall<
  Args extends readonly (CommandArgument | undefined)[],
  Flags extends object,
> = Args extends readonly []
  ? (input?: CommandInput<Args, Flags>) => Command
  : undefined extends Args[0]
    ? (input?: CommandInput<Args, Flags>) => Command
    : (input: CommandInput<Args, Flags>) => Command;
