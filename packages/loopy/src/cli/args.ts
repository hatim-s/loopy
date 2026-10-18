import { parseArgs } from "node:util";

const OPTIONS = {
  format: { type: "string" },
  "input-json": { type: "string" },
  "input-file": { type: "string" },
  follow: { type: "boolean" },
  cron: { type: "string" },
  tz: { type: "string" },
  concurrency: { type: "string" },
  help: { type: "boolean", short: "h" },
  home: { type: "string" },
  "lease-ms": { type: "string" },
  cwd: { type: "string" },
  out: { type: "string" },
  name: { type: "string" },
  port: { type: "string" },
  replace: { type: "boolean" },
  stdin: { type: "boolean" },
} as const;

const GLOBAL_OPTIONS = ["home", "cwd", "help"] as const;

const COMMAND_OPTIONS = new Map<string, readonly (keyof typeof OPTIONS)[]>(
  Object.entries({
    run: ["input-json", "input-file"],
    resume: [],
    schedule: ["cron", "tz", "input-json"],
    logs: ["follow"],
    "daemon run": ["concurrency", "port", "lease-ms"],
    "daemon install": ["concurrency", "port"],
    save: ["replace"],
    graph: ["format"],
    types: ["out", "name"],
    ui: ["port"],
    "secrets set": ["stdin"],
  } satisfies Record<string, readonly (keyof typeof OPTIONS)[]>),
);

const OPTION_TYPES = new Map(Object.entries(OPTIONS).map(([name, option]) => [name, option.type]));

export type ParsedCliArgs = ReturnType<typeof parseCliArgs>;

type Flag = { name: string; inline: string | undefined; type: "string" | "boolean" | undefined };

/** Splits `--name=value` and looks the name up; `type` is undefined for loopy inputs. */
function describeFlag(arg: string, allowed?: ReadonlySet<string>): Flag {
  const equals = arg.indexOf("=");
  const name = arg.slice(2, equals < 0 ? undefined : equals);

  return {
    name,
    inline: equals < 0 ? undefined : arg.slice(equals + 1),
    type: !allowed || allowed.has(name) ? OPTION_TYPES.get(name) : undefined,
  };
}

/** Whether a `--name` token without `=` consumes the token after it. */
function takesNextToken(flag: Flag, next: string | undefined): boolean {
  if (flag.inline !== undefined || flag.type === "boolean") {
    return false;
  }

  return next !== undefined && !next.startsWith("--");
}

/** The first token that is neither an option nor an option value. */
function findCommands(args: string[]): string[] {
  const commands: string[] = [];

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];

    if (arg === undefined || arg === "--") {
      break;
    }

    if (!arg.startsWith("-")) {
      commands.push(arg);

      if (commands.length === 2) {
        break;
      }

      continue;
    }

    if (arg.startsWith("--") && takesNextToken(describeFlag(arg), args[index + 1])) {
      index++;
    }
  }

  return commands;
}

function recordInput(inputs: Map<string, string>, arg: string, next: string | undefined): boolean {
  if (!arg.startsWith("--")) {
    throw new Error(`Expected a loopy input flag, received '${arg}'.`);
  }

  const flag = describeFlag(arg);

  if (!flag.name) {
    throw new Error(`Expected a loopy input flag, received '${arg}'.`);
  }

  if (inputs.has(flag.name)) {
    throw new Error(`Loopy input --${flag.name} was provided more than once.`);
  }

  const consumesNext = flag.inline === undefined;

  if (consumesNext && (next === undefined || next.startsWith("--"))) {
    throw new Error(
      `Loopy input --${flag.name} requires a value. Use --${flag.name}=value for a value starting with --.`,
    );
  }

  inputs.set(flag.name, flag.inline ?? next ?? "");

  return consumesNext;
}

/** Copies a known option to `cli`; returns true when it consumed the value token after it. */
function recordOption(
  cli: string[],
  { arg, flag, next }: { arg: string; flag?: Flag; next?: string },
) {
  cli.push(arg);

  if (flag?.type !== "string" || flag.inline !== undefined) {
    return false;
  }

  if (next === undefined || next.startsWith("--")) {
    throw new Error(`Option --${flag.name} requires a value.`);
  }

  cli.push(next);

  return true;
}

function recordArgument(
  state: {
    cli: string[];
    inputs: Map<string, string>;
    allowed: ReadonlySet<string>;
    command: string;
  },
  arg: string,
  options: { next?: string; inputsOnly: boolean },
) {
  const { cli, inputs, allowed, command } = state;
  const flag = arg.startsWith("--") ? describeFlag(arg, allowed) : undefined;
  const isInput = options.inputsOnly || (flag !== undefined && flag.type === undefined);

  if (
    (isInput && command !== "run") ||
    (arg.startsWith("-") && !arg.startsWith("--") && arg !== "-h")
  ) {
    throw new Error(`Unknown option '${arg}' for loopy ${command}. Run loopy --help for usage.`);
  }

  return isInput
    ? recordInput(inputs, arg, options.next)
    : recordOption(cli, { arg, flag, next: options.next });
}

/** One pass over argv: known options go to `cli`, unknown `--flags` become loopy inputs. */
function splitArguments(args: string[], command: string) {
  const acceptsInputs = command === "run";
  const allowed = new Set<string>([...GLOBAL_OPTIONS, ...(COMMAND_OPTIONS.get(command) ?? [])]);
  const cli: string[] = [];
  const inputs = new Map<string, string>();
  let inputsOnly = false;

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];

    if (arg === undefined) {
      break;
    }

    if (arg === "--" && acceptsInputs) {
      inputsOnly = true;
      continue;
    }

    if (arg === "--") {
      // parseArgs keeps everything after the separator positional, as `types` needs.
      cli.push(...args.slice(index));
      break;
    }

    const consumedNext = recordArgument({ cli, inputs, allowed, command }, arg, {
      next: args[index + 1],
      inputsOnly,
    });

    if (consumedNext) {
      index++;
    }
  }

  return { cli, inputs };
}

export function parseCliArgs(args: string[]) {
  const [command = "", action] = findCommands(args);

  const scope = ["daemon", "secrets"].includes(command)
    ? `${command} ${action ?? ""}`.trim()
    : command;

  const { cli, inputs } = splitArguments(args, scope);

  const parsed = parseArgs({ args: cli, options: OPTIONS, allowPositionals: true, strict: true });

  const sources =
    Number(inputs.size > 0) +
    Number(parsed.values["input-json"] !== undefined) +
    Number(parsed.values["input-file"] !== undefined);

  if (sources > 1) {
    throw new Error("Choose one input source: named flags, --input-json, or --input-file.");
  }

  return {
    values: parsed.values,
    positionals: parsed.positionals,
    namedInput: inputs.size ? Object.fromEntries(inputs) : undefined,
  };
}
