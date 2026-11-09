import { basename } from "node:path";
import type { CommandDescriptor } from "@loopy/sdk";
import { parseFlags } from "./help-flags";
import {
  parsePositionals,
  parsePositionalToken,
  USAGE_LINE,
  usageLines,
  usageTokens,
} from "./help-usage";

export type ParsedHelp = {
  descriptor: CommandDescriptor;
  warnings: string[];
};

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
): Pick<CommandDescriptor, "positionalSeparator" | "revisionPaths"> {
  const usage = usageLines(lines).find((line) => line.trim());
  const separator = usage && /\[--\]\s+<(?:pathspec|path|file)>/i.exec(usage);

  if (!usage || !separator) {
    return { positionalSeparator: false };
  }

  const preceding = usageTokens(usage.slice(0, separator.index))
    .map(parsePositionalToken)
    .filter((operand) => operand !== undefined);

  if (!preceding.length) {
    return { positionalSeparator: true };
  }

  return {
    positionalSeparator: false,
    revisionPaths: preceding.every((operand) => /^revision(?:-range)?$/.test(operand.name)),
  };
}

export function parseCliHelp(binary: string, path: readonly string[], help: string): ParsedHelp {
  const normalized = help.replaceAll("\r\n", "\n").replace(/.\x08/g, "");
  const lines = normalized.split("\n");
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
    key: [basename(binary), ...path].join("."),
    ...operandLayout(lines),
    program: binary,
    path,
    positionals,
    flags,
  };

  return { descriptor, warnings };
}
