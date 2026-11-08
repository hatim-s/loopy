import type { PositionalDefinition } from "@loopy/sdk/host";

export const USAGE_LINE = /^Usage:\s*\S/i;

const SECTION_HEADING = /^(?:[A-Za-z][\w /-]*:|[A-Z][A-Z /-]*)\s*$/;

const POSITIONAL_NAME = /^[A-Za-z][A-Za-z0-9_-]*$/;

export function section(lines: string[], title: string): string[] {
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
export function parsePositionalToken(token: string): PositionalDefinition | undefined {
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

export function usageLines(lines: string[]): string[] {
  const usage = lines.find((line) => USAGE_LINE.test(line));

  if (usage) {
    return [usage.replace(/^Usage:\s*/i, "")];
  }

  const usageSection = section(lines, "Usage");

  return usageSection.length ? usageSection : section(lines, "Synopsis");
}

export function usageTokens(line: string): string[] {
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

export function parsePositionals(lines: string[]): PositionalDefinition[] {
  const { tokens, fromSection } = positionalCandidates(lines);
  const result: PositionalDefinition[] = [];
  const seen = new Set<string>();

  for (const line of tokens) {
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
