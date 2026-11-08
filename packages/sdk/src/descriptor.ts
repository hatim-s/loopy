import { COMMAND_PLATFORMS, type CommandFlag } from "@loopy/core";

export type PositionalDefinition = {
  readonly name: string;
  readonly optional?: boolean;
  readonly variadic?: boolean;
};

export type CommandDefinition = {
  readonly program: string;
  readonly path?: readonly string[];
  readonly positionalSeparator?: boolean;
  readonly flagsAfterPositionals?: boolean;
  readonly revisionPaths?: boolean;
  readonly positionals?: readonly PositionalDefinition[];
  readonly parsedPositionals?: readonly PositionalDefinition[];
  readonly flags?: Readonly<Record<string, CommandFlag>>;
  readonly style?: "equals" | "space";
  readonly preset?: { readonly flags: Readonly<Record<string, string | number | boolean>> };
  readonly exclude?: readonly string[];
  readonly okExitCodes?: readonly number[];
};

/** A variant changes only how argv renders, so operands and exit codes stay platform neutral. */
export type CommandVariantDefinition = Partial<
  Pick<CommandDefinition, "program" | "path" | "flags" | "style" | "preset">
>;

/** Command data shared by built-in commands, author defineCommand calls and generated wrappers. */
export type CommandDeclaration = CommandDefinition & {
  readonly variants?: {
    readonly [P in (typeof COMMAND_PLATFORMS)[number]]?: CommandVariantDefinition;
  };
};

/** Built-ins take their key from their namespace path; author commands state it. */
export type CommandDescriptor = CommandDeclaration & {
  readonly key: string;
  /** Path of an author parser module, relative to the declaring module. */
  readonly parse?: string;
};

export type CommandOperands<A, F> = {
  readonly args?: readonly A[];
  readonly revisions?: readonly A[];
  readonly paths?: readonly A[];
  readonly flags?: Readonly<Record<string, F>>;
};

/** Parsed built-ins adjust operands and derived flags after parsed flag validation. */
export type Prepare = <A, F>(
  input: CommandOperands<A | string, F | boolean>,
) => CommandOperands<A | string, F | boolean>;

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

type FlagValue<F extends CommandFlag> = F["kind"] extends "boolean"
  ? boolean
  : F["kind"] extends "number"
    ? number
    : F extends { readonly choices: infer C extends readonly string[] }
      ? C[number]
      : string;

type FlagInput<F extends CommandFlag> = F extends { readonly pairs: true }
  ? Record<string, string>
  : F extends { readonly optionalValue: true }
    ? FlagValue<F> | true
    : FlagValue<F>;

type Flags<D extends CommandDeclaration> = D extends {
  readonly flags: infer F extends Readonly<Record<string, CommandFlag>>;
}
  ? keyof F extends never
    ? Record<string, never>
    : {
        readonly [K in keyof F]?: F[K] extends { readonly repeatable: true }
          ? readonly FlagInput<F[K]>[]
          : FlagInput<F[K]>;
      }
  : Record<string, never>;

type Args<D extends CommandDeclaration> = D extends {
  readonly positionals: infer P extends readonly PositionalDefinition[];
}
  ? Positionals<P>
  : readonly string[];

type Operands<D extends CommandDeclaration> = D extends {
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

type ParsedDescriptor<D extends CommandDeclaration> = D extends {
  readonly parsedPositionals: infer P extends readonly PositionalDefinition[];
}
  ? Omit<D, "positionals"> & { readonly positionals: P }
  : D;

export type Input<D extends CommandDeclaration> = Operands<ParsedDescriptor<D>> & {
  flags?: Omit<Flags<D>, ProtectedKeys<D>> & { readonly [K in ProtectedKeys<D>]?: never };
};

export type RawInput<D extends CommandDeclaration> = Operands<D> & {
  flags?: Flags<D>;
};

export function platformVariant(
  descriptor: CommandDeclaration,
  platform: (typeof COMMAND_PLATFORMS)[number],
): CommandDefinition {
  const variant = descriptor.variants?.[platform];

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

function optionIdentity(flag: CommandFlag | undefined): string {
  return JSON.stringify([...(flag?.prefix ?? []), flag?.cli]);
}

export function validateCommandDeclaration(descriptor: CommandDeclaration): void {
  for (const definition of [
    descriptor,
    ...COMMAND_PLATFORMS.map((platform) => platformVariant(descriptor, platform)),
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
