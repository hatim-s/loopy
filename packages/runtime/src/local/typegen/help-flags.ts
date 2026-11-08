import type { CommandFlag } from "@loopy/core";
import { section } from "./help-usage";
import { identifier } from "./names";

const OPTION_START = /^\s*(?:-\w,\s*)?--[A-Za-z0-9]/;

const OPTION_ALIASES = /^\s*(?:(?:-<[^>\s]+>|-[\w-]+(?:[ =]<[^>\s]+>)?),\s*)+/;

const OPTION_LINE =
  /^\s*(--[A-Za-z0-9][A-Za-z0-9-]*)(?:([ =])(<[^>\s]+>|\[[A-Z][A-Z0-9_-]*\]|[A-Za-z][A-Za-z0-9_-]*)|(\[=<[^>\s]+>\]))?(\.\.\.)?(?:\s{2,}.*)?$/;

const NUMERIC_PLACEHOLDER = /(?:^|_)(count|number|timeout|limit|port|seconds|ms)(?:$|_)/;

const POSSIBLE_VALUES = /\[possible values:\s*([^\]]+)\]/i;

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

  let flag: CommandFlag = { cli, kind: flagKind(placeholder) };

  if (repeatable) {
    flag = { ...flag, repeatable: true };
  }

  if (optionalValue) {
    flag = { ...flag, optionalValue: true };
  }

  if (match[4] || match[2] === "=") {
    flag = { ...flag, style: "equals" };
  }

  if (choices?.length) {
    flag = { ...flag, choices };
  }

  return flag;
}

export function parseFlags(lines: string[], warnings: string[]) {
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
