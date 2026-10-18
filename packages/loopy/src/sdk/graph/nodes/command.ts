import {
  type CommandFlagSpec,
  type GraphRetry,
  type OutSchema,
  parseArgv,
  RAW_COMMAND_OUTPUT,
  type RateLimit,
} from "../../../core/index.js";
import {
  type CommandDescriptor,
  type CommandOperands,
  commandKey,
  validateCommandDescriptor,
} from "../../define-command.js";
import { currentBuilder, type GraphBuilder } from "../builder.js";
import { commandArgv } from "../command-argv.js";
import type { CommandInput, CommandRawInput } from "../command-input.js";
import { type AuthorData, type Ref, type RefValue, type SchemaRef, serialize } from "../ref.js";
import { type Normalized, normalizeOut, type Output } from "../schema.js";
import { refuse } from "../validate.js";
import { retry } from "./code.js";

type Options = {
  label?: string;
  cwd?: string | Ref<string>;
  env?: Record<string, string | Ref<string>>;
  stdin?: string | Ref<string>;
  retry?: Partial<GraphRetry>;
  rateLimit?: RateLimit;
};

type Input = CommandOperands<string | RefValue>;

type Values = Readonly<Record<string, AuthorData<RefValue>>>;

function commandNode<S extends OutSchema>(
  builder: GraphBuilder,
  command: {
    key: string;
    out: S;
    argv: readonly AuthorData<RefValue>[];
    flags: Values;
    flagSpec: CommandFlagSpec | null;
    okExitCodes: readonly number[];
    parse: { input: Values } | null;
  },
  options: Options,
) {
  const node = builder.add(
    {
      kind: "command",
      key: command.key,
      out: command.out,
      argv: command.argv.map((value) => serialize(value, builder)),
      flags: serialize(command.flags, builder),
      flagSpec: command.flagSpec,
      options: {
        cwd: serialize(options.cwd, builder),
        env: serialize(options.env ?? {}, builder),
        stdin: serialize(options.stdin, builder),
      },
      rateLimit: options.rateLimit ?? null,
      retry: retry(options.retry),
      okExitCodes: [...command.okExitCodes],
      parse: command.parse
        ? { bundleHash: null, input: serialize(command.parse.input, builder) }
        : null,
    },
    options.label ?? null,
  );

  return builder.schemaRef(node.id, command.out);
}

type CallArguments<I> = I extends { args: readonly unknown[] }
  ? [input: I, options?: Options]
  : [input?: I, options?: Options];

export type CommandCall<D extends CommandDescriptor, S extends OutSchema> = {
  (...args: CallArguments<CommandInput<D>>): SchemaRef<S>;
  raw: (
    ...args: CallArguments<
      CommandRawInput<D extends { readonly raw: infer R extends CommandDescriptor } ? R : D>
    >
  ) => SchemaRef<typeof RAW_COMMAND_OUTPUT>;
};

// A parser's result is only kept when the command declares what it returns.
type ParsedOutput<D> = D extends { readonly parse: string }
  ? { readonly out: Exclude<Output, null | undefined> }
  : unknown;

export function defineCommand<const D extends CommandDescriptor>(
  descriptor: D & ParsedOutput<D>,
): CommandCall<D, D extends { readonly out: infer S extends Output } ? Normalized<S> : null>;
export function defineCommand<
  const S extends Exclude<Output, null | undefined>,
  const D extends CommandDescriptor & { readonly parse: string; readonly out?: never },
>(descriptor: D, out: S): CommandCall<D, Normalized<S>>;
export function defineCommand(
  descriptor: CommandDescriptor,
  schema?: Output,
): {
  (...args: never[]): RefValue;
  raw: (...args: never[]) => RefValue;
} {
  validateCommandDescriptor(descriptor);

  if (schema !== undefined && descriptor.out !== undefined) {
    refuse("invalid_schema", "Declare out on the descriptor or as the second argument, not both.");
  }

  const out = normalizeOut(schema ?? descriptor.out);

  if (descriptor.parse !== undefined && out === null) {
    refuse("invalid_schema", `Command '${descriptor.key}' has a parser, so it must declare out.`);
  }

  function factory(mode: "parsed" | "raw", output: OutSchema) {
    return (input: Input = {}, options: Options = {}): RefValue => {
      const builder = currentBuilder();
      const key = commandKey(descriptor);
      const rendered = commandArgv(descriptor, input, { key, mode });

      return commandNode(
        builder,
        {
          key,
          out: output,
          argv: [rendered.program, ...rendered.argv],
          flags: rendered.flags,
          flagSpec: rendered.flagSpec,
          okExitCodes: descriptor.okExitCodes ?? [0],
          parse: mode === "parsed" && descriptor.parse ? { input: rendered.parseInput } : null,
        },
        options,
      );
    };
  }

  return Object.assign(factory("parsed", out), {
    raw: factory("raw", RAW_COMMAND_OUTPUT),
  });
}

function shell(key: string, argv: readonly (string | Ref<string>)[], options: Options) {
  return commandNode(
    currentBuilder(),
    {
      key,
      out: RAW_COMMAND_OUTPUT,
      argv,
      flags: {},
      flagSpec: null,
      okExitCodes: [0],
      parse: null,
    },
    options,
  );
}

function exec(argv: readonly (string | Ref<string>)[], options: Options = {}) {
  return shell("sh.exec", argv, options);
}

function run(line: string, options: Options = {}) {
  return shell("sh.run", parseArgv(line), options);
}

export const sh = Object.assign(exec, { exec, run });

export function defineCommands<const D extends Record<string, CommandDescriptor>>(table: D) {
  const entries: [string, object][] = Object.entries(table).map(([key, descriptor]) => [
    key,
    defineCommand(descriptor),
  ]);

  // SAFETY: Each table key keeps the call signature of its own descriptor and output schema.
  return Object.fromEntries(entries) as {
    [K in keyof D]: CommandCall<
      D[K],
      D[K] extends { readonly out: infer S extends Output } ? Normalized<S> : null
    >;
  };
}
