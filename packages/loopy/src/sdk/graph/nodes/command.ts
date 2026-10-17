import { type CommandResult, type GraphRetry, parseArgv } from "../../../core/index.js";
import type { CommandDescriptor } from "../../define-command.js";
import { currentBuilder } from "../builder.js";
import { commandArgv } from "../command-argv.js";
import type { CommandInput, CommandRawInput } from "../command-input.js";
import { type AuthorValue, type Ref, type RefValue, serialize, serializeValues } from "../ref.js";

type Options = {
  cwd?: string | Ref<string>;
  env?: Record<string, string | Ref<string>>;
  stdin?: string | Ref<string>;
  retry?: Partial<GraphRetry>;
};

type Input = {
  args?: readonly (string | Ref<string>)[];
  revisions?: readonly (string | Ref<string>)[];
  paths?: readonly (string | Ref<string>)[];
  flags?: Readonly<Record<string, AuthorValue>>;
};

type Output<D extends CommandDescriptor> = D extends { parse: (...args: never[]) => infer R }
  ? R
  : CommandResult;

function record({
  label,
  descriptor,
  input,
  options,
  mode,
}: {
  label: string;
  descriptor: CommandDescriptor;
  input: Input;
  options: Options;
  mode: "parsed" | "raw";
}) {
  const builder = currentBuilder();
  const key = descriptor.key ?? `${descriptor.namespace}.${descriptor.name}`;
  const rendered = commandArgv(descriptor, input, mode);

  const node = builder.add(
    {
      kind: "command",
      key,
      argv: [rendered.program, ...rendered.argv].map((arg) => serialize(arg, builder)),
      flags: serializeValues(rendered.flags, builder),
      flagSpec: rendered.flagSpec,
      options: {
        cwd: serialize(options.cwd, builder),
        env: serializeValues(options.env ?? {}, builder),
        stdin: serialize(options.stdin, builder),
      },
      retry: builder.retry(options.retry),
      okExitCodes: [...(descriptor.okExitCodes ?? [0])],
      parse: mode === "parsed" && descriptor.parse ? { bundleHash: null } : null,
    },
    label,
  );

  return node.id;
}

export function defineCommand<const D extends CommandDescriptor>(descriptor: D) {
  function call(label: string, input: CommandInput<D>, options?: Options): Ref<Output<D>>;
  function call(label: string, input: Input, options: Options = {}): Ref<Output<D>> {
    return currentBuilder().ref(record({ label, descriptor, input, options, mode: "parsed" }));
  }

  function raw(label: string, input?: CommandRawInput<D>, options?: Options): Ref<CommandResult>;
  function raw(label: string, input: Input = {}, options: Options = {}): Ref<CommandResult> {
    return currentBuilder().ref(record({ label, descriptor, input, options, mode: "raw" }));
  }

  return Object.assign(call, { raw });
}

function shell({
  label,
  key,
  argv,
  options,
}: {
  label: string;
  key: string;
  argv: readonly (string | RefValue)[];
  options: Options;
}) {
  const builder = currentBuilder();

  const node = builder.add(
    {
      kind: "command",
      key,
      argv: argv.map((arg) => serialize(arg, builder)),
      flags: {},
      options: {
        cwd: serialize(options.cwd, builder),
        env: serializeValues(options.env ?? {}, builder),
        stdin: serialize(options.stdin, builder),
      },
      retry: builder.retry(options.retry),
      okExitCodes: [0],
      parse: null,
    },
    label,
  );

  return builder.ref<CommandResult>(node.id);
}

function exec(label: string, argv: readonly (string | RefValue)[], options: Options = {}) {
  return shell({ label, key: "sh.exec", argv, options });
}

function run(label: string, line: string, options: Options = {}) {
  return shell({ label, key: "sh.run", argv: parseArgv(line), options });
}

export const sh = Object.assign(exec, { exec, run });
