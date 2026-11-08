import { Effect } from "effect";
import type { Context, Invocation } from "./context";
import { CliError } from "./errors";

export type OptionSpec =
  | { readonly type: "boolean"; readonly description: string; readonly short?: string }
  | {
      readonly type: "string";
      readonly value: string;
      readonly description: string;
      readonly required?: true;
    }
  | {
      readonly type: "integer";
      readonly value: string;
      readonly description: string;
      readonly min: number;
      readonly max?: number;
      readonly default?: number;
    }
  | {
      readonly type: "choice";
      readonly choices: readonly [string, ...string[]];
      readonly description: string;
      readonly default: string;
    };

export type Options = Readonly<Record<string, OptionSpec>>;

type OptionValue<O extends OptionSpec> = O extends { type: "boolean" }
  ? boolean
  : O extends { type: "choice"; choices: readonly (infer C)[] }
    ? C
    : O extends { type: "integer"; default: number }
      ? number
      : O extends { type: "integer" }
        ? number | undefined
        : O extends { required: true }
          ? string
          : string | undefined;

export type OptionValues<O extends Options> = { readonly [K in keyof O]: OptionValue<O[K]> };

export type PositionalSpec = {
  readonly name: string;
  readonly label: string;
  readonly arity?: "optional" | "rest";
};

type PositionalValues<P extends readonly PositionalSpec[]> = {
  readonly [K in keyof P]: P[K] extends { arity: "rest" }
    ? readonly string[]
    : P[K] extends { arity: "optional" }
      ? string | undefined
      : string;
};

export const RUN_ID = { name: "run-id", label: "Run ID" } as const satisfies PositionalSpec;

/** What the parser hands a command: the flags present and option text, keyed by declared name. */
export type Arguments = {
  readonly flags: ReadonlySet<string>;
  readonly values: ReadonlyMap<string, string>;
  readonly positionals: readonly string[];
  readonly namedInput: Readonly<Record<string, string>> | undefined;
};

export type Command = {
  readonly path: readonly [string, ...string[]];
  readonly summary: string;
  readonly options: Options;
  readonly positionals: readonly PositionalSpec[];
  readonly namedInput: boolean;
  readonly run: (context: Context, parsed: Arguments) => Effect.Effect<void, Error>;
};

function integerRange(spec: { min: number; max?: number }) {
  return spec.max === undefined ? `of at least ${spec.min}` : `from ${spec.min} to ${spec.max}`;
}

const decodeOption = Effect.fn(function* (
  name: string,
  spec: OptionSpec,
  { flags, values }: Pick<Arguments, "flags" | "values">,
) {
  if (spec.type === "boolean") {
    return flags.has(name);
  }

  const raw = values.get(name);

  if (raw === undefined) {
    if (spec.type === "string" && spec.required) {
      return yield* new CliError({ message: `--${name} is required.` });
    }

    return spec.type === "string" ? undefined : spec.default;
  }

  if (spec.type === "string") {
    return raw;
  }

  if (spec.type === "choice") {
    if (!spec.choices.includes(raw)) {
      const uses = spec.choices.map((choice) => `--${name} ${choice}`).join(" or ");

      return yield* new CliError({ message: `Use ${uses}.` });
    }

    return raw;
  }

  const value = Number(raw);

  if (
    !/^-?\d+$/.test(raw) ||
    !Number.isSafeInteger(value) ||
    value < spec.min ||
    (spec.max !== undefined && value > spec.max)
  ) {
    return yield* new CliError({ message: `--${name} must be an integer ${integerRange(spec)}.` });
  }

  return value;
});

export const decodeOptions = <O extends Options>(
  options: O,
  parsed: Pick<Arguments, "flags" | "values">,
) =>
  Effect.map(
    Effect.forEach(Object.entries(options), ([name, spec]) =>
      Effect.map(decodeOption(name, spec, parsed), (value) => [name, value] as const),
    ),
    // SAFETY: Every declared key was decoded by its own spec, which is the mapping OptionValues applies.
    (entries) => Object.fromEntries(entries) as OptionValues<O>,
  );

function decodePositionals<P extends readonly PositionalSpec[]>(
  specs: P,
  values: readonly string[],
) {
  return Effect.gen(function* () {
    const decoded: (string | undefined | readonly string[])[] = [];
    let index = 0;

    for (const spec of specs) {
      if (spec.arity === "rest") {
        decoded.push(values.slice(index));
        index = values.length;
        continue;
      }

      const value = values[index];
      index++;

      if (!value && spec.arity !== "optional") {
        return yield* new CliError({ message: `${spec.label} is required.` });
      }

      decoded.push(value);
    }

    if (index < values.length) {
      return yield* new CliError({
        message: `Unexpected arguments: ${values.slice(index).join(" ")}.`,
      });
    }

    // SAFETY: The loop pushed one entry per spec with the arity its PositionalValues member names.
    return decoded as PositionalValues<P>;
  });
}

/** Declares a command once; parsing, usage and dispatch all read this entry. */
export function defineCommand<
  const O extends Options,
  const P extends readonly PositionalSpec[],
  E extends Error,
>(spec: {
  readonly path: readonly [string, ...string[]];
  readonly summary: string;
  readonly options: O;
  readonly positionals: P;
  readonly namedInput?: true;
  readonly run: (
    invocation: Invocation<OptionValues<O>, PositionalValues<P>>,
  ) => Effect.Effect<void, E>;
}): Command {
  const withUsage = (error: CliError) =>
    new CliError({
      message: `${error.message} Run loopy ${spec.path.join(" ")} --help for usage.`,
    });

  return {
    path: spec.path,
    summary: spec.summary,
    options: spec.options,
    positionals: spec.positionals,
    namedInput: spec.namedInput ?? false,
    run: (context, parsed) =>
      Effect.gen(function* () {
        const values = yield* Effect.mapError(decodeOptions(spec.options, parsed), withUsage);

        const args = yield* Effect.mapError(
          decodePositionals(spec.positionals, parsed.positionals),
          withUsage,
        );

        yield* spec.run({ ...context, values, args, namedInput: parsed.namedInput });
      }),
  };
}
