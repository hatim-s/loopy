import { createHash } from "node:crypto";
import { basename } from "node:path";
import type { CommandDescriptor, FlagDefinition, PositionalDefinition } from "../../core/index.js";
import { identifier } from "./names.js";

export type ParsedHelp = {
  descriptor: CommandDescriptor;
  warnings: string[];
};

const USAGE_LINE = /^Usage:\s*\S/i;
const SECTION_HEADING = /^[A-Za-z][\w /-]*:\s*$/;
const POSITIONAL_NAME = /^[A-Za-z][A-Za-z0-9_-]*$/;
const OPTION_START = /^\s*(?:-\w,\s*)?--[A-Za-z0-9]/;
const OPTION_LINE =
  /^\s*(?:(?:-\w,\s*)?)(--[A-Za-z0-9][A-Za-z0-9-]*)(?:[ =](<[^>\s]+>|\[[A-Z][A-Z0-9_-]*\])|(\[=<[^>\s]+>\]))?(\.\.\.)?(?:\s{2,}.*)?$/;
const NUMERIC_PLACEHOLDER = /(?:^|_)(count|number|timeout|limit|port|seconds|ms)(?:$|_)/;
const POSSIBLE_VALUES = /\[possible values:\s*([^\]]+)\]/i;

function section(lines: string[], title: string): string[] {
  const start = lines.findIndex((line) => line.trim() === `${title}:`);
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
  const rawName = token.replace(/[<>[\]]/g, "").replace(/\.\.\.$/, "");
  if (!POSITIONAL_NAME.test(rawName) || rawName.toUpperCase() === "OPTIONS") {
    return undefined;
  }
  return { name: rawName.toLowerCase(), optional, ...(variadic ? { variadic: true } : {}) };
}

/** Candidate tokens per line: the first column of an Arguments section, else bracketed usage words. */
function positionalCandidates(lines: string[]): { tokens: string[][]; fromSection: boolean } {
  const argumentsSection = section(lines, "Arguments");
  if (argumentsSection.length) {
    return {
      tokens: argumentsSection.map((line) => [line.trim().split(/\s{2,}/)[0] ?? ""]),
      fromSection: true,
    };
  }
  const usage = lines.find((line) => USAGE_LINE.test(line));
  const source = usage ? [usage.replace(/^Usage:\s*/i, "")] : section(lines, "Usage");
  return {
    tokens: source.map((line) =>
      line
        .trim()
        .split(/\s+/)
        .filter((token) => token.startsWith("[") || token.startsWith("<")),
    ),
    fromSection: false,
  };
}

export function parsePositionals(lines: string[]): PositionalDefinition[] {
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

export function choicesAfter(lines: string[], start: number): string[] | undefined {
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

function flagKind(placeholder: string | undefined): FlagDefinition["kind"] {
  if (!placeholder) {
    return "boolean";
  }
  return NUMERIC_PLACEHOLDER.test(placeholder) ? "number" : "string";
}

function parseFlagMatch(match: RegExpExecArray, options: string[], index: number): FlagDefinition {
  const cli = match[1] ?? "";
  const placeholder = (match[2] ?? match[3])?.replace(/[<>[\]=]/g, "").toLowerCase();
  const optionalValue = Boolean(match[3] || match[2]?.startsWith("["));
  const choices = choicesAfter(options, index);
  const repeatable = Boolean(
    match[4] || /\brepeatable\b/i.test(descriptionLines(options, index).join(" ")),
  );
  return {
    cli,
    kind: flagKind(placeholder),
    ...(repeatable ? { repeatable: true } : {}),
    ...(optionalValue ? { optionalValue: true } : {}),
    ...(match[3] ? { attachedValue: true } : {}),
    ...(choices?.length ? { choices } : {}),
  };
}

export function parseFlags(lines: string[], warnings: string[]): Record<string, FlagDefinition> {
  const flags: Record<string, FlagDefinition> = {};
  const optionsSection = section(lines, "Options");
  const options = optionsSection.length ? optionsSection : section(lines, "Flags");
  for (const [index, line] of options.entries()) {
    const match = OPTION_LINE.exec(line);
    if (!match) {
      if (/^\s{0,8}(?:-\w,\s*)?--[\w-]+/.test(line)) {
        warnings.push(`Could not parse option: ${line.trim()}`);
      }
      continue;
    }
    const cli = match[1];
    if (!cli) {
      continue;
    }
    const name = identifier(cli);
    if (!name) {
      warnings.push(`Could not name option: ${cli}`);
      continue;
    }
    if (flags[name]) {
      warnings.push(`Generated name '${name}' collides; skipped ${cli}`);
      continue;
    }
    flags[name] = parseFlagMatch(match, options, index);
  }
  if (!options.length) {
    warnings.push("No Options or Flags section found; generated command has no flags");
  }
  return flags;
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

export function parseCliHelp(binary: string, path: readonly string[], help: string): ParsedHelp {
  const lines = help.replaceAll("\r\n", "\n").split("\n");
  const warnings: string[] = [];
  if (!help.trim()) {
    throw new Error("CLI help output is empty.");
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
  if (Object.values(flags).some((flag) => flag.kind !== "boolean" && !flag.repeatable)) {
    warnings.push("Help may omit which valued flags can repeat; review repeatable flag metadata");
  }
  const descriptor: CommandDescriptor = {
    program: binary,
    path,
    positionals,
    flags,
    helpHash: createHash("sha256").update(help).digest("hex"),
  };
  return { descriptor, warnings };
}
