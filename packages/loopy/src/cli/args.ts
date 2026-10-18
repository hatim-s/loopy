import { parseArgs } from "node:util";
import { z } from "zod";
import { DaemonError } from "./errors.js";

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

const optionValues = z.object({
  home: z.string().optional(),
  cwd: z.string().optional(),
  help: z.boolean().optional(),
  format: z.enum(["json", "text"]).optional(),
  "input-json": z.string().optional(),
  "input-file": z.string().optional(),
  follow: z.boolean().optional(),
  cron: z.string().optional(),
  tz: z.string().optional(),
  action: z.enum(["set", "enable", "disable", "off"]).optional(),
  concurrency: z.coerce.number().int().min(1).optional(),
  port: z.coerce.number().int().min(0).max(65535).optional(),
  "lease-ms": z.coerce.number().int().min(1000).optional(),
  out: z.string().optional(),
  name: z.string().optional(),
  replace: z.boolean().optional(),
  stdin: z.boolean().optional(),
});

const globals = optionValues.pick({ home: true, cwd: true, help: true });

const fields = optionValues.shape;

const commandSchemas = {
  run: globals.extend({ "input-json": fields["input-json"], "input-file": fields["input-file"] }),
  resume: globals,
  cancel: globals,
  inspect: globals,
  list: globals,
  runs: globals,
  logs: globals.extend({ follow: fields.follow }),
  save: globals.extend({ replace: fields.replace }),
  graph: globals.extend({ format: fields.format.default("json") }),
  types: globals.extend({ out: fields.out.unwrap(), name: fields.name }),
  ui: globals.extend({ port: fields.port }),
  schedule: globals
    .extend({
      action: fields.action.default("set"),
      cron: fields.cron,
      tz: fields.tz,
      "input-json": fields["input-json"],
    })
    .refine(
      (value) =>
        value.action === "set" ||
        (value.cron === undefined && value.tz === undefined && value["input-json"] === undefined),
      { message: "Only schedule set accepts cron, timezone and input." },
    ),
  "daemon run": globals.extend({
    concurrency: fields.concurrency.default(4),
    port: fields.port.default(4310),
    "lease-ms": fields["lease-ms"],
  }),
  "daemon install": globals.extend({
    concurrency: fields.concurrency.default(4),
    port: fields.port.default(4310),
  }),
  "daemon uninstall": globals,
  "daemon status": globals,
  "secrets set": globals.extend({ stdin: fields.stdin }),
  "secrets list": globals,
  "secrets remove": globals,
};

const schemas = new Map(Object.entries(commandSchemas));

const GLOBAL_OPTIONS = Object.keys(globals.shape);

const COMMAND_OPTIONS = new Map(
  Object.entries(commandSchemas).map(([name, schema]) => [name, Object.keys(schema.shape)]),
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
    throw new DaemonError("bad_request", `Expected a loopy input flag, received '${arg}'.`);
  }

  const flag = describeFlag(arg);

  if (!flag.name) {
    throw new DaemonError("bad_request", `Expected a loopy input flag, received '${arg}'.`);
  }

  if (inputs.has(flag.name)) {
    throw new DaemonError("bad_request", `Loopy input --${flag.name} was provided more than once.`);
  }

  const consumesNext = flag.inline === undefined;

  if (consumesNext && (next === undefined || next.startsWith("--"))) {
    throw new DaemonError(
      "bad_request",
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
    throw new DaemonError("bad_request", `Option --${flag.name} requires a value.`);
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
    throw new DaemonError(
      "bad_request",
      `Unknown option '${arg}' for loopy ${command}. Run loopy --help for usage.`,
    );
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
    throw new DaemonError(
      "bad_request",
      "Choose one input source: named flags, --input-json, or --input-file.",
    );
  }

  return {
    values: valuesFor(scope, parsed),
    positionals: parsed.positionals,
    namedInput: inputs.size ? Object.fromEntries(inputs) : undefined,
  };
}

function valuesFor(
  scope: string,
  parsed: ReturnType<typeof parseArgs>,
): z.output<typeof optionValues> {
  if (parsed.values.help || !scope) {
    return globals.parse(parsed.values);
  }

  const schema = schemas.get(scope);

  if (!schema) {
    throw new DaemonError("bad_request", `Unknown command '${scope}'. Run loopy --help.`);
  }

  const action = scope === "schedule" ? { action: parsed.positionals[2] } : {};

  const parsedOptions = schema.safeParse({ ...parsed.values, ...action });

  if (!parsedOptions.success) {
    throw new DaemonError(
      "bad_request",
      parsedOptions.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("\n"),
    );
  }

  return parsedOptions.data;
}
