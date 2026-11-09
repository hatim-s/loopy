import { type ParseArgsOptionDescriptor, parseArgs } from "node:util";
import { Effect } from "effect";
import {
  type Arguments,
  type Command,
  decodeOptions,
  type OptionSpec,
  type Options,
  type OptionValues,
} from "./command";
import { GLOBAL_OPTIONS } from "./context";
import { CliError } from "./errors";

type Token = ReturnType<typeof tokenize>[number];

type OptionToken = Extract<Token, { kind: "option" }>;

export type ParsedCommandLine =
  | { readonly kind: "usage"; readonly command: Command | undefined }
  | {
      readonly kind: "command";
      readonly command: Command;
      readonly globals: OptionValues<typeof GLOBAL_OPTIONS>;
      readonly arguments: Arguments;
    };

function parseArgsOption(spec: OptionSpec): ParseArgsOptionDescriptor {
  if (spec.type !== "boolean") {
    return { type: "string" };
  }

  return spec.short === undefined ? { type: "boolean" } : { type: "boolean", short: spec.short };
}

function tokenize(args: readonly string[], options: Options) {
  const config = Object.fromEntries(
    Object.entries(options).map(([name, spec]) => [name, parseArgsOption(spec)]),
  );

  return parseArgs({
    args: [...args],
    options: config,
    strict: false,
    allowPositionals: true,
    tokens: true,
  }).tokens;
}

/** Leading positionals name the command; every option any command declares may come before it. */
function locate(commands: readonly Command[], args: readonly string[]) {
  const every: Options = Object.fromEntries([
    ...Object.entries(GLOBAL_OPTIONS),
    ...commands.flatMap((command) => Object.entries(command.options)),
  ]);

  const tokens = tokenize(args, every);
  const terminator = tokens.findIndex((token) => token.kind === "option-terminator");

  const words = tokens
    .slice(0, terminator < 0 ? undefined : terminator)
    .flatMap((token) => (token.kind === "positional" ? [token] : []));

  let match: Command | undefined;

  for (const command of commands) {
    if (
      command.path.every((word, index) => words[index]?.value === word) &&
      command.path.length > (match?.path.length ?? 0)
    ) {
      match = command;
    }
  }

  return {
    command: match,
    words: words.map((word) => word.value),
    pathIndices: new Set(words.slice(0, match?.path.length ?? 0).map((word) => word.index)),
    help: tokens.some((token) => token.kind === "option" && token.name === "help"),
  };
}

function unknownCommand(commands: readonly Command[], words: readonly string[]) {
  const [group, action] = words;

  const actions = commands.flatMap((command) =>
    command.path[0] === group && command.path[1] ? [command.path[1]] : [],
  );

  if (actions.length === 0) {
    return new CliError({ message: `Unknown command '${group}'. Run loopy --help.` });
  }

  const choices = `${actions.slice(0, -1).join(", ")} or ${actions.at(-1)}`;

  const problem =
    action === undefined ? `Choose a ${group} action.` : `Unknown ${group} action '${action}'.`;

  return new CliError({ message: `${problem} Use loopy ${group} ${choices}.` });
}

const optionText = Effect.fn(function* (token: OptionToken) {
  if (token.value === undefined || (!token.inlineValue && token.value.startsWith("-"))) {
    return yield* new CliError({
      message: `Option ${token.rawName} requires a value. Use ${token.rawName}=value for a value starting with -.`,
    });
  }

  return token.value;
});

function recordInput(
  inputs: Map<string, string>,
  { name, value, inline }: { name: string; value: string | undefined; inline: boolean },
) {
  if (!name) {
    return Effect.fail(
      new CliError({ message: "Expected a loopy input flag such as --key value." }),
    );
  }

  if (inputs.has(name)) {
    return Effect.fail(
      new CliError({ message: `Loopy input --${name} was provided more than once.` }),
    );
  }

  if (value === undefined || (!inline && value.startsWith("--"))) {
    return Effect.fail(
      new CliError({
        message: `Loopy input --${name} requires a value. Use --${name}=value for a value starting with --.`,
      }),
    );
  }

  inputs.set(name, value);

  return Effect.void;
}

/** After `--`, every token is a loopy input, so reserved option names can be inputs too. */
const separatedInputs = Effect.fn(function* (inputs: Map<string, string>, args: readonly string[]) {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] ?? "";

    if (!arg.startsWith("--")) {
      return yield* new CliError({ message: `Expected a loopy input flag, received '${arg}'.` });
    }

    const equals = arg.indexOf("=");
    const inline = equals >= 0;
    const value = inline ? arg.slice(equals + 1) : args[index + 1];
    yield* recordInput(inputs, { name: arg.slice(2, inline ? equals : undefined), value, inline });

    if (!inline) {
      index++;
    }
  }
});

type Walk = {
  readonly command: Command;
  readonly args: readonly string[];
  readonly known: Options;
  readonly flags: Set<string>;
  readonly values: Map<string, string>;
  readonly inputs: Map<string, string>;
  readonly consumed: Set<number>;
};

const optionToken = Effect.fn(function* (walk: Walk, token: OptionToken) {
  const path = walk.command.path.join(" ");
  const spec = Object.hasOwn(walk.known, token.name) ? walk.known[token.name] : undefined;

  if (spec?.type === "boolean" && token.inlineValue) {
    return yield* new CliError({ message: `Option ${token.rawName} does not take a value.` });
  }

  if (spec?.type === "boolean") {
    walk.flags.add(token.name);

    return;
  }

  if (spec) {
    walk.values.set(token.name, yield* optionText(token));

    return;
  }

  if (!walk.command.namedInput || !token.rawName.startsWith("--")) {
    return yield* new CliError({
      message: `Unknown option '${token.rawName}' for loopy ${path}. Run loopy ${path} --help for usage.`,
    });
  }

  const inline = token.inlineValue === true;

  if (!inline) {
    walk.consumed.add(token.index + 1);
  }

  yield* recordInput(walk.inputs, {
    name: token.name,
    value: inline ? token.value : walk.args[token.index + 1],
    inline,
  });
});

const commandArguments = Effect.fn(function* (command: Command, args: readonly string[]) {
  const walk: Walk = {
    command,
    args,
    known: { ...GLOBAL_OPTIONS, ...command.options },
    flags: new Set(),
    values: new Map(),
    inputs: new Map(),
    consumed: new Set(),
  };

  const positionals: string[] = [];

  for (const token of tokenize(args, walk.known)) {
    if (walk.consumed.has(token.index)) {
      continue;
    }

    if (token.kind === "positional") {
      positionals.push(token.value);
    } else if (token.kind === "option") {
      yield* optionToken(walk, token);
    } else if (command.namedInput) {
      yield* separatedInputs(walk.inputs, args.slice(token.index + 1));
      break;
    }
  }

  const parsed: Arguments = {
    flags: walk.flags,
    values: walk.values,
    positionals,
    namedInput: walk.inputs.size > 0 ? Object.fromEntries(walk.inputs) : undefined,
  };

  return parsed;
});

export const parseCommandLine = Effect.fn(function* (
  commands: readonly Command[],
  args: readonly string[],
) {
  const located = locate(commands, args);
  const { command } = located;

  if (!command) {
    if (located.words.length === 0 || located.help) {
      return { kind: "usage", command: undefined } satisfies ParsedCommandLine;
    }

    return yield* unknownCommand(commands, located.words);
  }

  const parsed = yield* commandArguments(
    command,
    args.flatMap((arg, index) => (located.pathIndices.has(index) ? [] : [arg])),
  );

  const globals = yield* decodeOptions(GLOBAL_OPTIONS, parsed);

  if (globals.help) {
    return { kind: "usage", command } satisfies ParsedCommandLine;
  }

  return { kind: "command", command, globals, arguments: parsed } satisfies ParsedCommandLine;
});
