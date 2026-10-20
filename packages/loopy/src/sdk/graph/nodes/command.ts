import type { Duration, RateLimit } from "../../../core/index.js";
import { type GraphRetry, type OutSchema, parseArgv } from "../../../core/index.js";
import { type CommandDescriptor, validateCommandDescriptor } from "../../define-command.js";
import { currentBuilder } from "../builder.js";
import { commandArgv } from "../command-argv.js";
import type { CommandInput, CommandRawInput } from "../command-input.js";
import { type AuthorValue, type Ref, type RefValue, serialize, serializeValues } from "../ref.js";

import type { Infer, SchemaFields } from "../types.js";

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

type Input = {
  args?: readonly (string | Ref<string>)[];
  revisions?: readonly (string | Ref<string>)[];
  paths?: readonly (string | Ref<string>)[];
  flags?: Readonly<Record<string, AuthorValue>>;
};

function record({
  label,
  descriptor,
  input,
  options,
  mode,
  out,
}: {
  label: string | null;
  descriptor: GraphCommandDescriptor;
  input: Input;
  options: Options;
  mode: "parsed" | "raw";
  out: OutSchema;
}) {
  const builder = currentBuilder();
  const key = descriptor.key ?? `${descriptor.namespace}.${descriptor.name}`;
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
        timeout: options.timeout,
        maxOutputBytes: options.maxOutputBytes,
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

export type GraphCommandDescriptor = Omit<CommandDescriptor, "parse"> & { parse?: string };

type CommandCall<D extends GraphCommandDescriptor, S extends OutSchema> = {
  (...args: CallArguments<CommandInput<D>>): Ref<Infer<S>, SchemaFields<S>>;
  readonly descriptor: D;
  raw: (
    ...args: CallArguments<CommandRawInput<D>>
  ) => Ref<Infer<typeof commandOutput>, SchemaFields<typeof commandOutput>>;
};

export function defineCommand<const D extends GraphCommandDescriptor>(
  descriptor: D & { parse?: never },
): CommandCall<D, typeof commandOutput>;
export function defineCommand<const S extends OutSchema, const D extends GraphCommandDescriptor>(
  descriptor: D & { parse: string },
  out: S,
): CommandCall<D, S>;
export function defineCommand<const S extends OutSchema, const D extends GraphCommandDescriptor>(
  descriptor: D,
  schema?: S,
) {
  validateCommandDescriptor(descriptor);
  const out = schema ?? commandOutput;
  function call(...args: CallArguments<CommandInput<D>>): Ref<Infer<S>, SchemaFields<S>>;
  function call(input: Input = {}, options: Options = {}): Ref<Infer<S>, SchemaFields<S>> {
    return currentBuilder().ref(
      record({ label: options.label ?? null, descriptor, input, options, mode: "parsed", out }),
      out,
    );
  }

  function raw(
    ...args: CallArguments<CommandRawInput<D>>
  ): Ref<Infer<typeof commandOutput>, SchemaFields<typeof commandOutput>>;
  function raw(
    input: Input = {},
    options: Options = {},
  ): Ref<Infer<typeof commandOutput>, SchemaFields<typeof commandOutput>> {
    return currentBuilder().ref(
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
      options: {
        cwd: serialize(options.cwd, builder),
        env: serializeValues(options.env ?? {}, builder),
        stdin: serialize(options.stdin, builder),
        timeout: options.timeout,
        maxOutputBytes: options.maxOutputBytes,
      },
      rateLimit: options.rateLimit ?? null,
      retry: builder.retry(options.retry),
      okExitCodes: [0],
      parse: null,
    },
    label,
  );

  return builder.ref<Infer<typeof commandOutput>, SchemaFields<typeof commandOutput>>(
    node.id,
    commandOutput,
  );
}

function exec(argv: readonly (string | RefValue)[], options: Options = {}) {
  return shell({ label: options.label ?? null, key: "sh.exec", argv, options });
}

function run(line: string, options: Options = {}) {
  return shell({ label: options.label ?? null, key: "sh.run", argv: parseArgv(line), options });
}

export const sh = Object.assign(exec, { exec, run });
