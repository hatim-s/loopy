import type { Command, OptionSpec, Options } from "./command";
import { GLOBAL_OPTIONS } from "./context";

const NOTES = `Choose one input source: named flags, --input-json, or --input-file.
Named inputs coerce numbers and booleans from the loopy's record specification.
In a terminal, missing required record fields are prompted before running.
Use --key=value for dash-prefixed values; use -- --key value for reserved names.

Author definitions compile during save; workers execute their pinned bundles.
Declare mode and secrets in loopy(). Sandbox runs deny network and restrict writes
outside the workspace. A failed sandbox launch never falls back to full mode.`;

function flag(name: string, spec: OptionSpec) {
  if (spec.type === "boolean") {
    return spec.short ? `--${name}, -${spec.short}` : `--${name}`;
  }

  return spec.type === "choice"
    ? `--${name} ${spec.choices.join("|")}`
    : `--${name} <${spec.value}>`;
}

function synopsis(command: Command) {
  const positionals = command.positionals.map((spec) =>
    spec.arity === "rest"
      ? `[${spec.name}...]`
      : spec.arity === "optional"
        ? `[${spec.name}]`
        : `<${spec.name}>`,
  );

  const options = Object.entries(command.options).map(([name, spec]) =>
    spec.type === "string" && spec.required ? flag(name, spec) : `[${flag(name, spec)}]`,
  );

  return [
    "loopy",
    ...command.path,
    ...positionals,
    ...(command.namedInput ? ["[--<input> <value> ...]"] : []),
    ...options,
  ].join(" ");
}

function details(spec: OptionSpec) {
  if (spec.type === "integer") {
    const range = spec.max === undefined ? `At least ${spec.min}.` : `${spec.min} to ${spec.max}.`;

    return [spec.description, range, spec.default === undefined ? "" : `Default: ${spec.default}.`];
  }

  return [spec.description, spec.type === "choice" ? `Default: ${spec.default}.` : ""];
}

function optionTable(options: Options) {
  const rows = Object.entries(options).map(
    ([name, spec]) => [flag(name, spec), details(spec)] as const,
  );

  const width = Math.max(...rows.map(([left]) => left.length));

  return rows.map(([left, right]) => `  ${left.padEnd(width)}  ${right.filter(Boolean).join(" ")}`);
}

export function usage(commands: readonly Command[]): string {
  return [
    "loopy: compiled workflow graphs for CLI tools",
    "",
    "Commands:",
    ...commands.flatMap((command) => [`  ${synopsis(command)}`, `      ${command.summary}`]),
    "",
    "Global options:",
    ...optionTable(GLOBAL_OPTIONS),
    "",
    "Run loopy <command> --help for its options and defaults.",
    "",
    NOTES,
  ].join("\n");
}

export function commandUsage(command: Command): string {
  const options = Object.keys(command.options).length > 0;

  return [
    synopsis(command),
    `  ${command.summary}`,
    ...(options ? ["", "Options:", ...optionTable(command.options)] : []),
    "",
    "Global options:",
    ...optionTable(GLOBAL_OPTIONS),
  ].join("\n");
}
