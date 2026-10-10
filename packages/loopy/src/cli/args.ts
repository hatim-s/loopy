import { parseArgs } from "node:util";

const OPTIONS = {
  help: { type: "boolean", short: "h" },
  home: { type: "string" },
  cwd: { type: "string" },
  input: { type: "string" },
  args: { type: "string" },
  full: { type: "boolean" },
  out: { type: "string" },
  name: { type: "string" },
  port: { type: "string" },
  "retry-uncertain": { type: "boolean" },
  force: { type: "boolean" },
  replace: { type: "boolean" },
  stdin: { type: "boolean" },
} as const;

const OPTION_TYPES = new Map(Object.entries(OPTIONS).map(([name, option]) => [name, option.type]));

export type ParsedCliArgs = ReturnType<typeof parseCliArgs>;

type Flag = { name: string; inline: string | undefined; type: "string" | "boolean" | undefined };

/** Splits `--name=value` and looks the name up; `type` is undefined for trigger inputs. */
function describeFlag(arg: string): Flag {
  const equals = arg.indexOf("=");
  const name = arg.slice(2, equals < 0 ? undefined : equals);

  return {
    name,
    inline: equals < 0 ? undefined : arg.slice(equals + 1),
    type: OPTION_TYPES.get(name),
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
function findCommand(args: string[]): string | undefined {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];

    if (arg === undefined || arg === "--") {
      return undefined;
    }

    if (!arg.startsWith("-")) {
      return arg;
    }

    if (arg.startsWith("--") && takesNextToken(describeFlag(arg), args[index + 1])) {
      index++;
    }
  }

  return undefined;
}

function recordInput(inputs: Map<string, string>, arg: string, next: string | undefined): boolean {
  if (!arg.startsWith("--")) {
    throw new Error(`Expected a trigger input flag, received '${arg}'.`);
  }

  const flag = describeFlag(arg);

  if (!flag.name) {
    throw new Error(`Expected a trigger input flag, received '${arg}'.`);
  }

  if (inputs.has(flag.name)) {
    throw new Error(`Trigger input --${flag.name} was provided more than once.`);
  }

  const consumesNext = flag.inline === undefined;

  if (consumesNext && (next === undefined || next.startsWith("--"))) {
    throw new Error(
      `Trigger input --${flag.name} requires a value. Use --${flag.name}=value for a value starting with --.`,
    );
  }

  inputs.set(flag.name, flag.inline ?? next ?? "");

  return consumesNext;
}

/** Copies a known option to `cli`; returns true when it consumed the value token after it. */
function recordOption(
  cli: string[],
  arg: string,
  flag: Flag | undefined,
  next: string | undefined,
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

/** One pass over argv: known options go to `cli`, unknown `--flags` become trigger inputs. */
function splitArguments(args: string[], acceptsInputs: boolean) {
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

    const flag = arg.startsWith("--") ? describeFlag(arg) : undefined;
    const isInput = inputsOnly || (flag !== undefined && flag.type === undefined);

    const consumedNext = isInput
      ? recordInput(inputs, arg, args[index + 1])
      : recordOption(cli, arg, flag, args[index + 1]);

    if (consumedNext) {
      index++;
    }
  }

  return { cli, inputs };
}

export function parseCliArgs(args: string[]) {
  const { cli, inputs } = splitArguments(args, findCommand(args) === "run");
  const parsed = parseArgs({ args: cli, options: OPTIONS, allowPositionals: true, strict: true });
  const command = parsed.positionals[0];

  if (command !== "run" && (inputs.size || parsed.values.args !== undefined)) {
    throw new Error("Trigger input flags and --args are only supported by loopy run.");
  }

  if (command !== "secrets" && parsed.values.stdin) {
    throw new Error("--stdin is only supported by loopy secrets set.");
  }

  const sources =
    Number(inputs.size > 0) +
    Number(parsed.values.args !== undefined) +
    Number(parsed.values.input !== undefined);

  if (sources > 1) {
    throw new Error("Choose one input source: named flags, --args, or --input.");
  }

  return {
    values: parsed.values,
    positionals: parsed.positionals,
    triggerInput: inputs.size ? Object.fromEntries(inputs) : undefined,
  };
}
