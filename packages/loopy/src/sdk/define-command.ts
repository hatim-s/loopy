import type {
  CommandResult,
  FlagDefinition as CoreFlag,
  Json,
  PositionalDefinition,
} from "../core/index.js";
import type { StepOptions } from "../runtime/index.js";
import { command } from "./ambient.js";
import { type RenderInput, renderArgv } from "./render-argv.js";

export type FlagDefinition = CoreFlag & {
  readonly supported?: boolean;
  readonly style?: "equals" | "space" | "attached" | "positional";
  readonly position?: "before" | "after";
  readonly order?: number;
  readonly prefix?: readonly string[];
  readonly pairs?: boolean;
  readonly terminator?: string;
};

export type CommandDefinition = {
  readonly program: string;
  readonly path?: readonly string[];
  readonly positionalSeparator?: boolean;
  readonly flagsAfterPositionals?: boolean;
  readonly revisionPaths?: boolean;
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

type FlagInput<F extends FlagDefinition> = F extends { readonly pairs: true }
  ? Record<string, string>
  : F extends { readonly optionalValue: true }
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

type Args<D extends CommandDescriptor> = D extends {
  readonly positionals: infer P extends readonly PositionalDefinition[];
}
  ? Positionals<P>
  : readonly string[];

type Operands<D extends CommandDescriptor> = D extends { readonly revisionPaths: true }
  ? { revisions?: readonly string[]; paths?: readonly string[] }
  : readonly [] extends Args<D>
    ? { args?: Args<D> }
    : { args: Args<D> };

type Input<D extends CommandDescriptor> = Operands<D> & { flags?: Flags<D> };

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
): (...args: CallArguments<Input<D>>) => Promise<CommandResult>;
export function defineCommand(
  descriptor: CommandDescriptor,
  environment: { platform: () => string } = { platform: () => PLATFORM },
): (input?: RenderInput, options?: CommandOptions) => Promise<CommandResult> {
  const key = descriptor.key ?? `${descriptor.namespace}.${descriptor.name}`;

  if (!descriptor.key && (!descriptor.namespace || !descriptor.name)) {
    throw new Error("Command identity is missing. Supply key or both namespace and name.");
  }

  return async (input = {}, options = {}) => {
    const resolved = platformVariant(descriptor, environment.platform());
    const args = renderArgv(resolved, input, key);

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
