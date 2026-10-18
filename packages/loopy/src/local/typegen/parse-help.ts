import { basename } from "node:path";
import type { CommandFlag } from "../../core/index.js";
import { sha256Hex } from "../../core/index.js";
import type { CommandDescriptor, PositionalDefinition } from "../../sdk/define-command.js";
import { ServiceError } from "../service-error.js";
import { identifier } from "./names.js";

export type GeneratedCommandDescriptor = CommandDescriptor & {
  helpHash: string;
  observedVersion?: string;
};

export type ParsedHelp = {
  descriptor: GeneratedCommandDescriptor;
  warnings: string[];
};

const USAGE_LINE = /^Usage:\s*\S/i;

const SECTION_HEADING = /^(?:[A-Za-z][\w /-]*:|[A-Z][A-Z /-]*)\s*$/;

const POSITIONAL_NAME = /^[A-Za-z][A-Za-z0-9_-]*$/;

const OPTION_START = /^\s*(?:-\w,\s*)?--[A-Za-z0-9]/;

const OPTION_ALIASES = /^\s*(?:(?:-<[^>\s]+>|-[\w-]+(?:[ =]<[^>\s]+>)?),\s*)+/;

const OPTION_LINE =
  /^\s*(--[A-Za-z0-9][A-Za-z0-9-]*)(?:([ =])(<[^>\s]+>|\[[A-Z][A-Z0-9_-]*\]|[A-Za-z][A-Za-z0-9_-]*)|(\[=<[^>\s]+>\]))?(\.\.\.)?(?:\s{2,}.*)?$/;

const NUMERIC_PLACEHOLDER = /(?:^|_)(count|number|timeout|limit|port|seconds|ms)(?:$|_)/;

const POSSIBLE_VALUES = /\[possible values:\s*([^\]]+)\]/i;

function section(lines: string[], title: string): string[] {
  const start = lines.findIndex(
    (line) => line.trim().replace(/:$/, "").toLowerCase() === title.toLowerCase(),
  );

  if (start < 0) {
    return [];
  }

  const end = lines.findIndex((line, index) => index > start && SECTION_HEADING.test(line));

  return lines.slice(start + 1, end < 0 ? undefined : end);
}

/** `<name>`, `[name]` or `name...` to a definition, or undefined for noise like OPTIONS. */
function parsePositionalToken(token: string): PositionalDefinition | undefined {
  const variadic = token.includes("...");
  const optional = token.startsWith("[");

  const rawName =
    token
      .replace(/[<>[\]]/g, "")
      .replace(/\.\.\.$/, "")
      .split(/\s+/)
      .at(-1) ?? "";

  if (!POSITIONAL_NAME.test(rawName) || ["OPTIONS", "FLAGS"].includes(rawName.toUpperCase())) {
    return undefined;
  }

  let positional: PositionalDefinition = { name: rawName.toLowerCase(), optional };

  if (variadic) {
    positional = { ...positional, variadic: true };
  }

  return positional;
}

/** Candidate tokens per line: the first column of an Arguments section, else bracketed usage words. */
type PositionalCandidates = { tokens: string[][]; fromSection: boolean };

function positionalCandidates(lines: string[]): PositionalCandidates {
  const argumentsSection = section(lines, "Arguments");

  if (argumentsSection.length) {
    return {
      tokens: argumentsSection.map((line) => [line.trim().split(/\s{2,}/)[0] ?? ""]),
      fromSection: true,
    };
  }

  return { tokens: usageLines(lines).map(usageTokens), fromSection: false };
}

function usageLines(lines: string[]): string[] {
  const usage = lines.find((line) => USAGE_LINE.test(line));

  if (usage) {
    return [usage.replace(/^Usage:\s*/i, "")];
  }

  const usageSection = section(lines, "Usage");

  return usageSection.length ? usageSection : section(lines, "Synopsis");
}

function usageTokens(line: string): string[] {
  const tokens: string[] = [];

  for (const match of line.matchAll(/\[?<[^>]+>(?:\.\.\.)?\]?|\[[A-Za-z][\w-]*(?:\.\.\.)?\]/g)) {
    const prefix = line.slice(0, match.index);

    if (/(?:^|[\s[])-{1,2}[\w-]+[ =]*$/.test(prefix)) {
      continue;
    }

    const depth = (prefix.match(/\[/g)?.length ?? 0) - (prefix.match(/\]/g)?.length ?? 0);
    tokens.push(depth > 0 && !match[0].startsWith("[") ? `[${match[0]}]` : match[0]);
  }

  return tokens;
}

function parsePositionals(lines: string[]): PositionalDefinition[] {
  const { tokens, fromSection } = positionalCandidates(lines);
  const result: PositionalDefinition[] = [];
  const seen = new Set<string>();

  for (const line of tokens) {
    // Without an Arguments section only the first usage line counts.
    if (!fromSection && result.length) {
      break;
    }

    for (const token of line) {
      const positional = parsePositionalToken(token);

      if (!positional || seen.has(positional.name)) {
        continue;
      }

      seen.add(positional.name);
      result.push(positional);
    }
  }

  return result;
}

function choicesAfter(lines: string[], start: number): string[] | undefined {
  for (let index = start; index < Math.min(lines.length, start + 12); index += 1) {
    const line = lines[index] ?? "";

    if (index > start && /^\s*--?[\w-]+(?:,|\s|$)/.test(line)) {
      break;
    }

    const match = POSSIBLE_VALUES.exec(line);

    if (match) {
      return match[1]
        ?.split(",")
        .map((part) => part.trim())
        .filter(Boolean);
    }
  }

  return undefined;
}

/** The option line plus its continuation lines, up to the next option. */
function descriptionLines(options: string[], index: number): string[] {
  const description: string[] = [options[index] ?? ""];

  for (let next = index + 1; next < options.length; next += 1) {
    const candidate = options[next] ?? "";

    if (OPTION_START.test(candidate)) {
      break;
    }

    description.push(candidate);
  }

  return description;
}

function flagKind(placeholder: string | undefined): CommandFlag["kind"] {
  if (!placeholder) {
    return "boolean";
  }

  return NUMERIC_PLACEHOLDER.test(placeholder) ? "number" : "string";
}

function parseFlagMatch(match: RegExpExecArray, options: string[], index: number): CommandFlag {
  const cli = match[1] ?? "";
  const placeholder = (match[3] ?? match[4])?.replace(/[<>[\]=]/g, "").toLowerCase();
  const optionalValue = Boolean(match[4] || match[3]?.startsWith("["));
  const choices = choicesAfter(options, index);

  const repeatable = Boolean(
    match[5] ||
      placeholder?.includes("...") ||
      (flagKind(placeholder) === "string" && placeholder?.endsWith("s")) ||
      /\b(?:repeatable|can be repeated|multiple)\b|\b(?:assign|add|request) (?:people|[a-z]+s)\b/i.test(
        descriptionLines(options, index).join(" "),
      ),
  );

  let metadata: Pick<Extract<CommandFlag, { kind: "boolean" }>, "cli" | "style" | "repeatable"> = {
    cli,
  };

  if (repeatable) {
    metadata = { ...metadata, repeatable: true };
  }

  if (match[4] || match[2] === "=") {
    metadata = { ...metadata, style: "equals" };
  }

  const kind = flagKind(placeholder);

  if (kind === "boolean") {
    return { ...metadata, kind };
  }

  let valued: Pick<Extract<CommandFlag, { kind: "number" }>, "optionalValue"> = {};

  if (optionalValue) {
    valued = { optionalValue: true };
  }

  if (kind === "number") {
    return { ...metadata, ...valued, kind };
  }

  return choices?.length
    ? { ...metadata, ...valued, kind, choices }
    : { ...metadata, ...valued, kind };
}

function parseFlags(lines: string[], warnings: string[]) {
  const flags: Record<string, CommandFlag> = {};
  const optionsSection = section(lines, "Options");

  const options = optionsSection.length
    ? optionsSection
    : [...section(lines, "Flags"), ...section(lines, "Command options")];

  for (const [index, line] of options.entries()) {
    const match = OPTION_LINE.exec(line.replace(OPTION_ALIASES, ""));

    if (!match) {
      if (/^\s{0,8}(?:-\w,\s*)?--[\w-]+/.test(line)) {
        warnings.push(`Could not parse option: ${line.trim()}`);
      }

      continue;
    }

    const cli = match[1] ?? "";
    const name = flagName(cli, flags, warnings);

    if (!name) {
      continue;
    }

    flags[name] = parseFlagMatch(match, options, index);
  }

  if (!options.length) {
    warnings.push("No Options or Flags section found; generated command has no flags");
  }

  return flags;
}

function flagName(cli: string, flags: Record<string, CommandFlag>, warnings: string[]) {
  if (!cli || cli === "--help" || cli === "--version") {
    return undefined;
  }

  const name = identifier(cli);

  if (!name) {
    warnings.push(`Could not name option: ${cli}`);

    return undefined;
  }

  if (flags[name]) {
    warnings.push(`Generated name '${name}' collides; skipped ${cli}`);

    return undefined;
  }

  return name;
}

/** True when a later usage line repeats the command prefix, meaning several usage forms exist. */
function hasMultipleUsageForms(lines: string[], prefix: string): boolean {
  const usageIndex = lines.findIndex((line) => USAGE_LINE.test(line));

  if (usageIndex < 0) {
    return false;
  }

  for (let index = usageIndex + 1; index < lines.length; index += 1) {
    const line = lines[index]?.trim() ?? "";

    if (!line) {
      return false;
    }

    if (line.startsWith(prefix)) {
      return true;
    }
  }

  return false;
}

function operandLayout(
  lines: string[],
  parts: readonly PositionalDefinition[],
): CommandDescriptor["operands"] {
  const usage = usageLines(lines).find((line) => line.trim());
  const separator = usage && /\[--\]\s+<(?:pathspec|path|file)>/i.exec(usage);

  if (!usage || !separator) {
    return { kind: "positional", parts, separator: false };
  }

  const preceding = usageTokens(usage.slice(0, separator.index))
    .map(parsePositionalToken)
    .filter((operand) => operand !== undefined);

  if (!preceding.length) {
    return { kind: "positional", parts, separator: true };
  }

  return preceding.every((operand) => /^revision(?:-range)?$/.test(operand.name))
    ? { kind: "revisionPaths" }
    : { kind: "positional", parts, separator: false };
}

export async function parseCliHelp(
  binary: string,
  path: readonly string[],
  help: string,
): Promise<ParsedHelp> {
  const normalized = help.replaceAll("\r\n", "\n").replace(/.\x08/g, "");
  const lines = normalized.split("\n");
  const warnings: string[] = [];

  if (!help.trim()) {
    throw new ServiceError("bad_request", `CLI help output for '${binary}' is empty.`);
  }

  const positionals = parsePositionals(lines);
  const flags = parseFlags(lines, warnings);

  if (hasMultipleUsageForms(lines, [basename(binary), ...path].join(" "))) {
    warnings.push(
      "Multiple Usage forms found; verify positional arguments for the selected subcommand",
    );
  }

  if (!positionals.length) {
    warnings.push("No positional arguments detected; verify the generated tuple");
  }

  if (
    Object.values(flags).some(
      (flag) => flag.kind !== "boolean" && !("repeatable" in flag && flag.repeatable),
    )
  ) {
    warnings.push("Help may omit which valued flags can repeat; review repeatable flag metadata");
  }

  const descriptor: GeneratedCommandDescriptor = {
    key: [basename(binary), ...path].join("."),
    operands: operandLayout(lines, positionals),
    program: binary,
    path,
    flags,
    helpHash: await sha256Hex(new TextEncoder().encode(help)),
  };

  return { descriptor, warnings };
}
