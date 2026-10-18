import type { RateLimit } from "../../../core/index.js";
import { type GraphRetry, type OutSchema, parseArgv } from "../../../core/index.js";
import {
  type CommandDescriptor,
  type CommandOperands,
  commandKey,
  validateCommandDescriptor,
} from "../../define-command.js";
import { currentBuilder } from "../builder.js";
import { commandArgv } from "../command-argv.js";
import type { CommandInput, CommandRawInput } from "../command-input.js";
import type { SchemaRef } from "../ref.js";
import { type Ref, type RefValue, serialize, serializeValues } from "../ref.js";

type Options = {
  label?: string;
  cwd?: string | Ref<string>;
  env?: Record<string, string | Ref<string>>;
  stdin?: string | Ref<string>;
  retry?: Partial<GraphRetry>;
  rateLimit?: RateLimit;
};

type Input = CommandOperands<string | RefValue>;

function record({
  label,
  descriptor,
  input,
  options,
  mode,
  out,
}: {
  label: string | null;
  descriptor: CommandDescriptor;
  input: Input;
  options: Options;
  mode: "parsed" | "raw";
  out: OutSchema;
}) {
  const builder = currentBuilder();
  const key = commandKey(descriptor);
  const rendered = commandArgv(descriptor, input, mode);

  const node = builder.add(
    {
      kind: "command",
      key,
      out,
      argv: [rendered.program, ...rendered.argv].map((arg) => serialize(arg, builder)),
      flags: serializeValues(rendered.flags, builder),
      flagSpec: rendered.flagSpec,
      options: {
        cwd: serialize(options.cwd, builder),
        env: serializeValues(options.env ?? {}, builder),
        stdin: serialize(options.stdin, builder),
      },
      rateLimit: options.rateLimit ?? null,
      retry: builder.retry(options.retry),
      okExitCodes: [...(descriptor.okExitCodes ?? [0])],
      parse:
        mode === "parsed" && descriptor.parse
          ? { bundleHash: null, input: serializeValues(rendered.parseInput, builder) }
          : null,
    },
    label,
  );

  return node.id;
}

export const commandOutput = {
  kind: "record",
  fields: { stdout: "string", stderr: "string", exitCode: "number" },
} as const;

type CallArguments<I> = I extends { args: readonly unknown[] }
  ? [input: I, options?: Options]
  : [input?: I, options?: Options];

export type CommandCall<D extends CommandDescriptor, S extends OutSchema> = {
  (...args: CallArguments<CommandInput<D>>): SchemaRef<S>;
  readonly descriptor: D;
  raw: (
    ...args: CallArguments<
      CommandRawInput<D extends { readonly raw: infer R extends CommandDescriptor } ? R : D>
    >
  ) => SchemaRef<typeof commandOutput>;
};

export function defineCommand<const D extends CommandDescriptor>(
  descriptor: D,
): CommandCall<D, D extends { readonly out: infer S extends OutSchema } ? S : typeof commandOutput>;
export function defineCommand<const S extends OutSchema, const D extends CommandDescriptor>(
  descriptor: D & { parse: string },
  out: S,
): CommandCall<D, S>;
export function defineCommand<const S extends OutSchema, const D extends CommandDescriptor>(
  descriptor: D,
  schema?: S,
) {
  validateCommandDescriptor(descriptor);
  const out = schema ?? descriptor.out ?? commandOutput;

  function call(input: Input = {}, options: Options = {}) {
    return currentBuilder().schemaRef(
      record({ label: options.label ?? null, descriptor, input, options, mode: "parsed", out }),
      out,
    );
  }

  function raw(
    ...args: CallArguments<
      CommandRawInput<D extends { readonly raw: infer R extends CommandDescriptor } ? R : D>
    >
  ): SchemaRef<typeof commandOutput>;
  function raw(input: Input = {}, options: Options = {}): SchemaRef<typeof commandOutput> {
    return currentBuilder().schemaRef(
      record({
        label: options.label ?? null,
        descriptor,
        input,
        options,
        mode: "raw",
        out: commandOutput,
      }),
      commandOutput,
    );
  }

  return Object.assign(call, { raw, descriptor });
}

function shell({
  label,
  key,
  argv,
  options,
}: {
  label: string | null;
  key: string;
  argv: readonly (string | RefValue)[];
  options: Options;
}) {
  const builder = currentBuilder();

  const node = builder.add(
    {
      kind: "command",
      key,
      out: commandOutput,
      argv: argv.map((arg) => serialize(arg, builder)),
      flags: {},
      flagSpec: null,
      options: {
        cwd: serialize(options.cwd, builder),
        env: serializeValues(options.env ?? {}, builder),
        stdin: serialize(options.stdin, builder),
      },
      rateLimit: options.rateLimit ?? null,
      retry: builder.retry(options.retry),
      okExitCodes: [0],
      parse: null,
    },
    label,
  );

  return builder.schemaRef(node.id, commandOutput);
}

function exec(argv: readonly (string | RefValue)[], options: Options = {}) {
  return shell({ label: options.label ?? null, key: "sh.exec", argv, options });
}

function run(line: string, options: Options = {}) {
  return shell({ label: options.label ?? null, key: "sh.run", argv: parseArgv(line), options });
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
      D[K] extends { readonly out: infer S extends OutSchema } ? S : typeof commandOutput
    >;
  };
}
