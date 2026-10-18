import type { CommandFlag, OutSchema } from "../core/index.js";

export type FlagDefinition = CommandFlag;

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
  readonly defaultArgs?: readonly string[];
  readonly prepare?: (counts: { args: number; flags: Set<string> }) => {
    flags?: Readonly<Record<string, string | number | boolean | undefined>>;
  };
  readonly parse?: string;
  readonly out?: OutSchema;
};

export type CommandDescriptor = CommandDefinition & {
  readonly key: string;
  readonly raw?: CommandDescriptor;
  readonly variants?: {
    readonly darwin?: Partial<CommandDefinition>;
    readonly linux?: Partial<CommandDefinition>;
  };
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

type Operands<D extends CommandDescriptor> = D extends {
  readonly revisionPaths: true;
}
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

export type Input<D extends CommandDescriptor> = Operands<ParsedDescriptor<D>> & {
  flags?: Omit<Flags<D>, ProtectedKeys<D>> & { readonly [K in ProtectedKeys<D>]?: never };
};

export type RawInput<D extends CommandDescriptor> = Operands<D> & {
  flags?: Flags<D>;
};

export function platformVariant(
  descriptor: CommandDescriptor,
  platform: string,
): CommandDefinition {
  const variant =
    platform === "darwin"
      ? descriptor.variants?.darwin
      : platform === "linux"
        ? descriptor.variants?.linux
        : undefined;

  return { ...descriptor, ...variant, flags: { ...descriptor.flags, ...variant?.flags } };
}

export function parsedFlags<Value>(
  descriptor: CommandDefinition,
  input: { flags?: Readonly<Record<string, Value>> },
) {
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

export function validateCommandDescriptor(descriptor: CommandDescriptor): void {
  for (const definition of [
    descriptor,
    platformVariant(descriptor, "darwin"),
    platformVariant(descriptor, "linux"),
  ]) {
    const seen = new Map<string, string>();

    for (const [name, flag] of Object.entries(definition.flags ?? {})) {
      const identity = optionIdentity(flag);
      const previous = seen.get(identity);

      if (previous !== undefined) {
        throw new Error(
          `Flags '${previous}' and '${name}' share CLI option '${flag.cli}'. Give each flag a unique CLI option.`,
        );
      }

      seen.set(identity, name);
    }
  }
}

export function commandKey(descriptor: Pick<CommandDescriptor, "key">) {
  return descriptor.key;
}
