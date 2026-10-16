import type {
  CommandResult,
  FlagDefinition as CoreFlag,
  Json,
  PositionalDefinition,
} from "../core/index.js";
import type { StepOptions } from "../runtime/index.js";
import { command } from "./ambient.js";

type FlagDefinition = CoreFlag & {
  readonly supported?: boolean;
  readonly style?: "equals" | "space" | "attached";
};

type CommandDefinition = {
  readonly program: string;
  readonly path?: readonly string[];
  readonly positionalSeparator?: boolean;
  readonly flagsAfterPositionals?: boolean;
  readonly positionals?: readonly PositionalDefinition[];
  readonly flags?: Readonly<Record<string, FlagDefinition>>;
  readonly style?: "equals" | "space";
  readonly parse?: (result: CommandResult) => Json;
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

type FlagInput<F extends FlagDefinition> = F extends { readonly optionalValue: true }
  ? FlagValue<F> | true
  : FlagValue<F>;

type Flags<D extends CommandDescriptor> = D extends {
  readonly flags: infer F extends Readonly<Record<string, FlagDefinition>>;
}
  ? {
      readonly [K in keyof F]?: F[K] extends { readonly repeatable: true }
        ? readonly FlagInput<F[K]>[]
        : FlagInput<F[K]>;
    }
  : Record<string, never>;

type Input<D extends CommandDescriptor> = {
  args?: D extends { readonly positionals: infer P extends readonly PositionalDefinition[] }
    ? Positionals<P>
    : readonly string[];
  flags?: Flags<D>;
};

function platformVariant(descriptor: CommandDescriptor, platform: string): CommandDefinition {
  const variant =
    platform === "darwin"
      ? descriptor.variants?.darwin
      : platform === "linux"
        ? descriptor.variants?.linux
        : undefined;

  return { ...descriptor, ...variant, flags: { ...descriptor.flags, ...variant?.flags } };
}

// BOUNDARY: JavaScript callers supply untyped flag values at this public API.
function flagTokens(
  flag: FlagDefinition,
  value: unknown,
  style: CommandDefinition["style"],
): string[] {
  if (value === undefined || (value === false && flag.kind === "boolean")) {
    return [];
  }

  if (flag.supported === false) {
    throw new Error(
      `Flag '${flag.cli}' is unavailable on this platform. Use sh.exec with a platform-specific alternative.`,
    );
  }

  if (value === true && (flag.kind === "boolean" || flag.optionalValue)) {
    return [flag.cli];
  }

  if (typeof value !== flag.kind || (typeof value === "number" && !Number.isFinite(value))) {
    throw new Error(
      `Flag '${flag.cli}' requires a ${flag.kind} value. Supply the declared flag type.`,
    );
  }

  if (flag.choices && !flag.choices.includes(String(value))) {
    throw new Error(
      `Flag '${flag.cli}' must be one of: ${flag.choices.join(", ")}. Choose an allowed value.`,
    );
  }

  const format = flag.style ?? (flag.attachedValue ? "attached" : (style ?? "space"));

  if (format === "space") {
    return [flag.cli, String(value)];
  }

  return [`${flag.cli}${format === "equals" ? "=" : ""}${String(value)}`];
}

// BOUNDARY: Validate flags once before handing argv to the executor.
function buildFlags(
  descriptor: CommandDefinition,
  values: Readonly<Record<string, unknown>>,
): string[] {
  const allowed = descriptor.flags ?? {};

  return Object.entries(values).flatMap(([name, value]) => {
    const flag = Object.hasOwn(allowed, name) ? allowed[name] : undefined;

    if (!flag) {
      throw new Error(
        `Unknown flag '${name}'. Use an allowed flag: ${Object.keys(allowed).join(", ") || "none"}.`,
      );
    }

    if (value === undefined) {
      return [];
    }

    if (flag.repeatable) {
      if (!Array.isArray(value)) {
        throw new Error(`Flag '${name}' is repeatable. Supply an array of values.`);
      }

      const items: readonly unknown[] = value;

      return items.flatMap((item) => flagTokens(flag, item, descriptor.style));
    }

    return flagTokens(flag, value, descriptor.style);
  });
}

export function defineCommand<const D extends CommandDescriptor>(
  descriptor: D,
  environment: { platform: () => string } = { platform: () => process.platform },
): (input?: Input<D>, options?: CommandOptions) => Promise<CommandResult> {
  const key = descriptor.key ?? `${descriptor.namespace}.${descriptor.name}`;

  if (!descriptor.key && (!descriptor.namespace || !descriptor.name)) {
    throw new Error("Command identity is missing. Supply key or both namespace and name.");
  }

  return async (input = {}, options = {}) => {
    const resolved = platformVariant(descriptor, environment.platform());
    const flags = buildFlags(resolved, input.flags ?? {});
    const args = [...(resolved.path ?? []), ...(resolved.flagsAfterPositionals ? [] : flags)];

    if (resolved.positionalSeparator && input.args?.length) {
      args.push("--");
    }

    args.push(...(input.args ?? []));

    if (resolved.flagsAfterPositionals) {
      args.push(...flags);
    }

    return command(
      key,
      {
        program: resolved.program,
        args,
        cwd: options.cwd,
        env: options.env,
        stdin: options.stdin,
      },
      options,
    );
  };
}
