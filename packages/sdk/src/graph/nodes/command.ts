import type { CommandResult, Duration, Json, RateLimit } from "@loopy/core";
import { type CommandFlagSpec, type GraphRetry, type OutSchema, parseArgv } from "@loopy/core";
import { type CommandDescriptor, type Prepare, validateCommandDescriptor } from "../../descriptor";
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

/** Built-in parsers receive the prepared operands; only wc reads them. */
export type Parser<R> = (result: CommandResult, input: { args?: readonly Json[] }) => R;

/** Symbol keys keep host metadata out of the author call surface the compiler enumerates. */
export const PARSER = Symbol("loopy.command.parser");

type CallArguments<I> = I extends { args: readonly unknown[] }
  ? [input: I, options?: Options]
  : [input?: I, options?: Options];

export type CommandCall<
  D extends CommandDescriptor,
  S extends OutSchema,
  R extends CommandDescriptor = D,
> = {
  (...args: CallArguments<CommandInput<D>>): Ref<Infer<S>, SchemaFields<S>>;
  readonly descriptor: D;
  raw: (...args: CallArguments<CommandRawInput<R>>) => CommandOutput;
};

function addCommand(
  node: {
    key: string;
    out: OutSchema;
    argv: readonly (string | RefValue)[];
    flags: Readonly<Record<string, AuthorValue>>;
    flagSpec?: CommandFlagSpec;
    okExitCodes: readonly number[];
    parse: Readonly<Record<string, AuthorValue>> | null;
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
      parse: node.parse && { bundleHash: null, input: serializeValues(node.parse, builder) },
    },
    options.label ?? null,
  ).id;
}

/** The direct call applies presets, exclusions and preparation; `.raw` passes flags through. */
type CallMode = { out: OutSchema; prepare?: Prepare; parses: boolean };

function descriptorCommand(
  descriptor: CommandDescriptor,
  input: CommandArguments,
  options: Options,
  mode: CallMode | null,
) {
  const rendered = commandArgv(
    descriptor,
    input,
    mode ? { kind: "parsed", prepare: mode.prepare } : { kind: "raw" },
  );

  return addCommand(
    {
      key: rendered.key,
      out: mode?.out ?? commandOutput,
      argv: [rendered.program, ...rendered.operands],
      flags: rendered.flags,
      flagSpec: rendered.flagSpec,
      okExitCodes: rendered.okExitCodes,
      parse: mode?.parses ? rendered.parseInput : null,
    },
    options,
  );
}

function commandCall<D extends CommandDescriptor, S extends OutSchema, R extends CommandDescriptor>(
  descriptor: D,
  mode: CallMode & { out: S },
  rawDescriptor: R,
) {
  new Set([descriptor, rawDescriptor]).forEach(validateCommandDescriptor);

  function call(...args: CallArguments<CommandInput<D>>): Ref<Infer<S>, SchemaFields<S>>;
  function call(
    input: CommandArguments = {},
    options: Options = {},
  ): Ref<Infer<S>, SchemaFields<S>> {
    return currentBuilder().ref(descriptorCommand(descriptor, input, options, mode), mode.out);
  }

  function raw(...args: CallArguments<CommandRawInput<R>>): CommandOutput;
  function raw(input: CommandArguments = {}, options: Options = {}): CommandOutput {
    return currentBuilder().ref<Infer<typeof commandOutput>, SchemaFields<typeof commandOutput>>(
      descriptorCommand(rawDescriptor, input, options, null),
      commandOutput,
    );
  }

  return Object.assign(call, { raw, descriptor });
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
  return commandCall(
    descriptor,
    { out: out ?? commandOutput, parses: Boolean(descriptor.parse) },
    descriptor,
  );
}

export function builtin<const D extends CommandDescriptor>(
  descriptor: D,
): CommandCall<D, typeof commandOutput>;
export function builtin<
  const D extends CommandDescriptor,
  const S extends OutSchema,
  const R extends CommandDescriptor = D,
>(
  descriptor: D,
  parsed: { parse: Parser<Infer<S>>; out: S; prepare?: Prepare; raw?: R },
): CommandCall<D, S, R>;
export function builtin<
  D extends CommandDescriptor,
  S extends OutSchema,
  R extends CommandDescriptor,
>(descriptor: D, parsed?: { parse: Parser<Infer<S>>; out: S; prepare?: Prepare; raw?: R }) {
  const mode: CallMode = parsed
    ? { out: parsed.out, prepare: parsed.prepare, parses: true }
    : { out: commandOutput, parses: false };

  const call = commandCall(descriptor, mode, parsed?.raw ?? descriptor);

  return parsed ? Object.assign(call, { [PARSER]: parsed.parse }) : call;
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
