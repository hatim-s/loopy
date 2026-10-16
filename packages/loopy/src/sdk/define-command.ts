import type { CommandResult, Json } from "../core/index.js";
import type { StepOptions } from "../runtime/index.js";
import { command } from "./ambient.js";
import { type RenderInput, renderArgv } from "./render-argv.js";

export type FlagDefinition = {
  readonly cli: string;
  readonly kind: "boolean" | "string" | "number";
  readonly repeatable?: boolean;
  readonly optionalValue?: boolean;
  readonly choices?: readonly string[];

  readonly supported?: boolean;
  readonly style?: "equals" | "space" | "attached" | "positional";
  readonly position?: "before" | "after";
  readonly order?: number;
  readonly prefix?: readonly string[];
  readonly pairs?: boolean;
  readonly terminator?: string;
};

export type PositionalDefinition = {
  readonly name: string;
  readonly optional?: boolean;
  readonly variadic?: boolean;
};

export type CommandDefinition = {
  readonly helpHash?: string;
  readonly observedVersion?: string;
  readonly program: string;
  readonly path?: readonly string[];
  readonly positionalSeparator?: boolean;
  readonly flagsAfterPositionals?: boolean;
  readonly revisionPaths?: boolean;
  readonly positionals?: readonly PositionalDefinition[];
  readonly parsedPositionals?: readonly PositionalDefinition[];
  readonly flags?: Readonly<Record<string, FlagDefinition>>;
  readonly style?: "equals" | "space";
  readonly preset?: {
    readonly flags: Readonly<
      Record<string, string | number | boolean | readonly string[] | Record<string, string>>
    >;
  };
  readonly exclude?: readonly string[];
  readonly okExitCodes?: readonly number[];
  /** Adjust operands and derived flags only after parsed flag validation. */
  readonly prepare?: (input: RenderInput) => RenderInput;
  readonly parse?: (result: CommandResult, input: RenderInput) => Json;
};

export type CommandDescriptor = CommandDefinition & {
  readonly namespace?: string;
  readonly name?: string;
  readonly key?: string;
  readonly variants?: {
    readonly darwin?: Partial<CommandDefinition>;
    readonly linux?: Partial<CommandDefinition>;
  };
};

export type CommandOptions = StepOptions & {
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string;
};

type Positionals<Parts extends readonly PositionalDefinition[]> = Parts extends readonly [
  infer First extends PositionalDefinition,
  ...infer Rest extends readonly PositionalDefinition[],
]
  ? First extends { readonly variadic: true }
    ? First extends { readonly optional: true }
      ? readonly string[]
      : readonly [string, ...string[]]
    : First extends { readonly optional: true }
      ? readonly [string?, ...Positionals<Rest>]
      : readonly [string, ...Positionals<Rest>]
  : readonly [];

type FlagValue<F extends FlagDefinition> = F["kind"] extends "boolean"
  ? boolean
  : F["kind"] extends "number"
    ? number
    : F extends { readonly choices: infer C extends readonly string[] }
      ? C[number]
      : string;

type FlagInput<F extends FlagDefinition> = F extends { readonly pairs: true }
  ? Record<string, string>
  : F extends { readonly optionalValue: true }
    ? FlagValue<F> | true
    : FlagValue<F>;

type Flags<D extends CommandDescriptor> = D extends {
  readonly flags: infer F extends Readonly<Record<string, FlagDefinition>>;
}
  ? keyof F extends never
    ? Record<string, never>
    : {
        readonly [K in keyof F]?: F[K] extends { readonly repeatable: true }
          ? readonly FlagInput<F[K]>[]
          : FlagInput<F[K]>;
      }
  : Record<string, never>;

type Args<D extends CommandDescriptor> = D extends {
  readonly positionals: infer P extends readonly PositionalDefinition[];
}
  ? Positionals<P>
  : readonly string[];

type Operands<D extends CommandDescriptor> = D extends { readonly revisionPaths: true }
  ? {
      revisions?: readonly string[];
      paths?: readonly string[];
      args?: D extends { readonly positionals: readonly PositionalDefinition[] } ? Args<D> : never;
    }
  : readonly [] extends Args<D>
    ? { args?: Args<D> }
    : { args: Args<D> };

type PresetKeys<D> = D extends { readonly preset: { readonly flags: infer F } } ? keyof F : never;

type ExcludedKeys<D> = D extends { readonly exclude: readonly (infer K extends string)[] }
  ? K
  : never;

type ProtectedKeys<D> = PresetKeys<D> | ExcludedKeys<D>;

type ParsedDescriptor<D extends CommandDescriptor> = D extends {
  readonly parsedPositionals: infer P extends readonly PositionalDefinition[];
}
  ? Omit<D, "positionals"> & { readonly positionals: P }
  : D;

type Input<D extends CommandDescriptor> = Operands<ParsedDescriptor<D>> & {
  flags?: Omit<Flags<D>, ProtectedKeys<D>> & { readonly [K in ProtectedKeys<D>]?: never };
};

type RawInput<D extends CommandDescriptor> = Operands<D> & { flags?: Flags<D> };

type CommandCall<D extends CommandDescriptor> = D extends {
  readonly parse: (result: CommandResult, input: RenderInput) => infer T extends Json;
}
  ? ((...args: CallArguments<Input<D>>) => Promise<T>) & {
      raw: (...args: CallArguments<RawInput<D>>) => Promise<CommandResult>;
    }
  : (...args: CallArguments<RawInput<D>>) => Promise<CommandResult>;

type Simplify<T> = { [K in keyof T]: T[K] } & {};

type CallArguments<I> = I extends { args: readonly string[] }
  ? [input: Simplify<I>, options?: CommandOptions]
  : [input?: Simplify<I>, options?: CommandOptions];

const PLATFORM = process.platform;

function platformVariant(descriptor: CommandDescriptor, platform: string): CommandDefinition {
  const variant =
    platform === "darwin"
      ? descriptor.variants?.darwin
      : platform === "linux"
        ? descriptor.variants?.linux
        : undefined;

  return { ...descriptor, ...variant, flags: { ...descriptor.flags, ...variant?.flags } };
}

export function defineCommand<const D extends CommandDescriptor>(
  descriptor: D,
  environment?: { platform: () => string },
): CommandCall<D>;
export function defineCommand(
  descriptor: CommandDescriptor,
  environment: { platform: () => string } = { platform: () => PLATFORM },
) {
  const key = descriptor.key ?? `${descriptor.namespace}.${descriptor.name}`;

  if (!descriptor.key && (!descriptor.namespace || !descriptor.name)) {
    throw new Error("Command identity is missing. Supply key or both namespace and name.");
  }

  for (const platform of ["default", "darwin", "linux"]) {
    validateCliOptions(platformVariant(descriptor, platform));
  }

  const raw = async (input: RenderInput = {}, options: CommandOptions = {}) => {
    const resolved = platformVariant(descriptor, environment.platform());

    return command(key, resolveCommand(resolved, input, key, options), options);
  };

  return Object.assign(createParsedCommand(descriptor, environment, key), { raw });
}

function createParsedCommand(
  descriptor: CommandDescriptor,
  environment: { platform: () => string },
  key: string,
) {
  return async (input: RenderInput = {}, options: CommandOptions = {}) => {
    const resolved = platformVariant(descriptor, environment.platform());
    const flags = parsedFlags(resolved, input);
    const prepared = resolved.prepare?.({ ...input, flags }) ?? { ...input, flags };

    const request = resolveCommand(
      { ...resolved, positionals: resolved.parsedPositionals ?? resolved.positionals },
      prepared,
      key,
      options,
    );

    if (!resolved.parse) {
      return command(key, request, options);
    }

    const parse = resolved.parse;

    return command(key, request, { ...options, okExitCodes: resolved.okExitCodes }, (result) =>
      parse(result, prepared),
    );
  };
}

function resolveCommand(
  descriptor: CommandDefinition,
  input: RenderInput,
  key: string,
  options: CommandOptions,
) {
  return {
    program: descriptor.program,
    args: renderArgv(descriptor, input, key),
    cwd: options.cwd,
    env: options.env,
    stdin: options.stdin,
  };
}

function validateCliOptions(descriptor: CommandDefinition) {
  const names = new Map<string, string>();

  for (const [name, flag] of Object.entries(descriptor.flags ?? {})) {
    const identity = optionIdentity(flag);
    const previous = names.get(identity);

    if (previous !== undefined) {
      throw new Error(
        `Flags '${previous}' and '${name}' share CLI option '${flag.cli}'. Give each flag a unique CLI option.`,
      );
    }

    names.set(identity, name);
  }
}

function parsedFlags(descriptor: CommandDefinition, input: RenderInput) {
  const flags = descriptor.flags ?? {};
  const preset = descriptor.preset?.flags ?? {};
  const protectedOptions = new Set(Object.keys(preset).map((name) => optionIdentity(flags[name])));

  for (const name of Object.keys(input.flags ?? {})) {
    if (descriptor.exclude?.includes(name) || protectedOptions.has(optionIdentity(flags[name]))) {
      throw new Error(
        `Flag '${name}' changes the parsed output format. Use .raw() to supply this flag.`,
      );
    }
  }

  return { ...input.flags, ...preset };
}

function optionIdentity(flag: FlagDefinition | undefined): string {
  return JSON.stringify([...(flag?.prefix ?? []), flag?.cli]);
}
