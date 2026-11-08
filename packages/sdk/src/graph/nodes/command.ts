import type { Duration, RateLimit } from "@loopy/core";
import {
  type CommandFlagSpec,
  type CommandVariant,
  type GraphRetry,
  type OutSchema,
  parseArgv,
} from "@loopy/core";
import {
  type CommandDeclaration,
  type CommandDescriptor,
  type Prepare,
  validateCommandDeclaration,
} from "../../descriptor";
import { currentBuilder, retryPolicy } from "../builder";
import { type CommandArguments, commandArgv } from "../command-argv";
import type { CommandInput, CommandRawInput } from "../command-input";
import { type AuthorValue, type Ref, type RefValue, serialize, serializeValues } from "../ref";
import type { Infer, SchemaFields } from "../types";

type Options = {
  label?: string;
  cwd?: string | Ref<string>;
  env?: Record<string, string | Ref<string>>;
  stdin?: string | Ref<string>;
  timeout?: Duration;
  maxOutputBytes?: number;
  retry?: Partial<GraphRetry>;
  rateLimit?: RateLimit;
};

export const commandOutput = {
  kind: "record",
  fields: { stdout: "string", stderr: "string", exitCode: "number" },
} as const;

type CommandOutput = Ref<Infer<typeof commandOutput>, SchemaFields<typeof commandOutput>>;

type CallArguments<I> = I extends { args: readonly unknown[] }
  ? [input: I, options?: Options]
  : [input?: I, options?: Options];

export type CommandCall<
  D extends CommandDeclaration,
  S extends OutSchema,
  R extends CommandDeclaration = D,
> = {
  (...args: CallArguments<CommandInput<D>>): Ref<Infer<S>, SchemaFields<S>>;
  raw: (...args: CallArguments<CommandRawInput<R>>) => CommandOutput;
};

function addCommand(
  node: {
    key: string;
    out: OutSchema;
    argv: readonly (string | RefValue)[];
    flags: Readonly<Record<string, AuthorValue>>;
    flagSpec?: CommandFlagSpec;
    variants?: Partial<Record<"darwin" | "linux", CommandVariant>>;
    okExitCodes: readonly number[];
    parse: { module: string | null } | null;
  },
  options: Options,
) {
  const builder = currentBuilder();

  return builder.add(
    {
      kind: "command",
      key: node.key,
      out: node.out,
      argv: node.argv.map((arg) => serialize(arg, builder)),
      flags: serializeValues(node.flags, builder),
      ...(node.flagSpec && { flagSpec: node.flagSpec }),
      ...(node.variants && Object.keys(node.variants).length > 0 && { variants: node.variants }),
      options: {
        cwd: serialize(options.cwd, builder),
        env: serializeValues(options.env ?? {}, builder),
        stdin: serialize(options.stdin, builder),
        timeout: options.timeout,
        maxOutputBytes: options.maxOutputBytes,
      },
      rateLimit: options.rateLimit ?? null,
      retry: retryPolicy(options.retry),
      okExitCodes: [...node.okExitCodes],
      parse: node.parse && { module: node.parse.module, bundleHash: null },
    },
    options.label ?? null,
  ).id;
}

/**
 * The direct call applies presets, exclusions and preparation; `.raw` passes flags through.
 * A parser module of null names the built-in parser registered under the command key.
 */
export type CallMode = {
  out: OutSchema;
  prepare?: Prepare;
  parser: { module: string | null } | null;
};

function descriptorCommand(
  key: string,
  descriptor: CommandDeclaration,
  input: CommandArguments,
  options: Options,
  mode: CallMode | null,
) {
  const rendered = commandArgv(
    key,
    descriptor,
    input,
    mode ? { kind: "parsed", prepare: mode.prepare } : { kind: "raw" },
  );

  return addCommand(
    {
      key,
      out: mode?.out ?? commandOutput,
      argv: [rendered.program, ...rendered.operands],
      flags: rendered.flags,
      flagSpec: rendered.flagSpec,
      variants: rendered.variants,
      okExitCodes: rendered.okExitCodes,
      parse: mode?.parser ?? null,
    },
    options,
  );
}

export function commandCall<
  D extends CommandDeclaration,
  S extends OutSchema,
  R extends CommandDeclaration,
>(key: string, descriptor: D, mode: CallMode & { out: S }, rawDescriptor: R): CommandCall<D, S, R> {
  new Set([descriptor, rawDescriptor]).forEach(validateCommandDeclaration);

  function call(...args: CallArguments<CommandInput<D>>): Ref<Infer<S>, SchemaFields<S>>;
  function call(
    input: CommandArguments = {},
    options: Options = {},
  ): Ref<Infer<S>, SchemaFields<S>> {
    return currentBuilder().ref(descriptorCommand(key, descriptor, input, options, mode), mode.out);
  }

  function raw(...args: CallArguments<CommandRawInput<R>>): CommandOutput;
  function raw(input: CommandArguments = {}, options: Options = {}): CommandOutput {
    return currentBuilder().ref<Infer<typeof commandOutput>, SchemaFields<typeof commandOutput>>(
      descriptorCommand(key, rawDescriptor, input, options, null),
      commandOutput,
    );
  }

  return Object.assign(call, { raw });
}

export function defineCommand<const D extends CommandDescriptor>(
  descriptor: D & { parse?: never },
): CommandCall<D, typeof commandOutput>;
export function defineCommand<const S extends OutSchema, const D extends CommandDescriptor>(
  descriptor: D & { parse: string },
  out: S,
): CommandCall<D, S>;
export function defineCommand<const S extends OutSchema, const D extends CommandDescriptor>(
  descriptor: D,
  out?: S,
) {
  if (!descriptor.key) {
    throw new Error(
      "defineCommand requires a nonempty key, such as 'gh.pr.create'. Add a key to the descriptor.",
    );
  }

  const parser = descriptor.parse === undefined ? null : { module: descriptor.parse };

  return commandCall(descriptor.key, descriptor, { out: out ?? commandOutput, parser }, descriptor);
}

function shell(key: string, argv: readonly (string | RefValue)[], options: Options) {
  const id = addCommand(
    { key, out: commandOutput, argv, flags: {}, okExitCodes: [0], parse: null },
    options,
  );

  return currentBuilder().ref<Infer<typeof commandOutput>, SchemaFields<typeof commandOutput>>(
    id,
    commandOutput,
  );
}

function exec(argv: readonly (string | RefValue)[], options: Options = {}) {
  return shell("sh.exec", argv, options);
}

function run(line: string, options: Options = {}) {
  return shell("sh.run", parseArgv(line), options);
}

export const sh = Object.assign(exec, { exec, run });
