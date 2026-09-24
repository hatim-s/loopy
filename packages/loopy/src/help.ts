import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { basename } from "node:path";
import { promisify } from "node:util";
import type { CommandDescriptor, FlagDefinition, PositionalDefinition } from "./command";

const execFileAsync = promisify(execFile);

export type ParsedHelp = {
  descriptor: CommandDescriptor;
  warnings: string[];
};

function identifier(value: string): string {
  const words = value
    .replace(/^--?/, "")
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean);
  return words
    .map((word, index) =>
      index === 0 ? word.toLowerCase() : word[0]?.toUpperCase() + word.slice(1).toLowerCase(),
    )
    .join("");
}

function section(lines: string[], title: string): string[] {
  const start = lines.findIndex((line) => line.trim() === `${title}:`);
  if (start < 0) return [];
  const end = lines.findIndex(
    (line, index) => index > start && /^[A-Za-z][\w /-]*:\s*$/.test(line),
  );
  return lines.slice(start + 1, end < 0 ? undefined : end);
}

function parsePositionals(lines: string[]): PositionalDefinition[] {
  const argumentsSection = section(lines, "Arguments");
  const usage = lines.find((line) => /^Usage:\s*\S/i.test(line));
  const source = argumentsSection.length
    ? argumentsSection
    : usage
      ? [usage.replace(/^Usage:\s*/i, "")]
      : section(lines, "Usage");
  const result: PositionalDefinition[] = [];
  const seen = new Set<string>();
  for (const line of source) {
    if (!argumentsSection.length && result.length) break;
    const candidates = argumentsSection.length
      ? [line.trim().split(/\s{2,}/)[0] ?? ""]
      : line.trim().split(/\s+/);
    for (const token of candidates) {
      if (!argumentsSection.length && !token.startsWith("[") && !token.startsWith("<")) continue;
      const variadic = token.includes("...");
      const optional = token.startsWith("[");
      const rawName = token.replace(/[<>[\]]/g, "").replace(/\.\.\.$/, "");
      if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(rawName) || rawName.toUpperCase() === "OPTIONS")
        continue;
      const name = rawName.toLowerCase();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      result.push({ name, optional, ...(variadic ? { variadic: true } : {}) });
    }
  }
  return result;
}

function choicesAfter(lines: string[], start: number): string[] | undefined {
  for (let index = start; index < Math.min(lines.length, start + 12); index += 1) {
    const line = lines[index] ?? "";
    if (index > start && /^\s*--?[\w-]+(?:,|\s|$)/.test(line)) break;
    const match = /\[possible values:\s*([^\]]+)\]/i.exec(line);
    if (match)
      return match[1]
        ?.split(",")
        .map((part) => part.trim())
        .filter(Boolean);
  }
  return undefined;
}

function parseFlags(lines: string[], warnings: string[]): Record<string, FlagDefinition> {
  const flags: Record<string, FlagDefinition> = {};
  const options = section(lines, "Options").length
    ? section(lines, "Options")
    : section(lines, "Flags");
  const optionLine =
    /^\s*(?:(?:-\w,\s*)?)(--[A-Za-z0-9][A-Za-z0-9-]*)(?:[ =](<[^>\s]+>|\[[A-Z][A-Z0-9_-]*\])|(\[=<[^>\s]+>\]))?(\.\.\.)?(?:\s{2,}.*)?$/;
  for (const [index, line] of options.entries()) {
    const match = optionLine.exec(line);
    if (!match) {
      if (/^\s{0,8}(?:-\w,\s*)?--[\w-]+/.test(line))
        warnings.push(`Could not parse option: ${line.trim()}`);
      continue;
    }
    const cli = match[1];
    if (!cli) continue;
    const name = identifier(cli);
    if (!name) {
      warnings.push(`Could not name option: ${cli}`);
      continue;
    }
    if (flags[name]) {
      warnings.push(`Generated name '${name}' collides; skipped ${cli}`);
      continue;
    }
    const placeholder = (match[2] ?? match[3])?.replace(/[<>[\]=]/g, "").toLowerCase();
    const optionalValue = Boolean(match[3] || match[2]?.startsWith("["));
    const choices = choicesAfter(options, index);
    const kind = !placeholder
      ? "boolean"
      : /(?:^|_)(count|number|timeout|limit|port|seconds|ms)(?:$|_)/.test(placeholder)
        ? "number"
        : "string";
    const description: string[] = [line];
    for (let next = index + 1; next < options.length; next += 1) {
      const candidate = options[next] ?? "";
      if (/^\s*(?:-\w,\s*)?--[A-Za-z0-9]/.test(candidate)) break;
      description.push(candidate);
    }
    const repeatable = Boolean(match[4] || /\brepeatable\b/i.test(description.join(" ")));
    flags[name] = {
      cli,
      kind,
      ...(repeatable ? { repeatable: true } : {}),
      ...(optionalValue ? { optionalValue: true } : {}),
      ...(match[3] ? { attachedValue: true } : {}),
      ...(choices?.length ? { choices } : {}),
    };
  }
  if (!options.length)
    warnings.push("No Options or Flags section found; generated command has no flags");
  return flags;
}

export function parseCliHelp(binary: string, path: readonly string[], help: string): ParsedHelp {
  const lines = help.replaceAll("\r\n", "\n").split("\n");
  const warnings: string[] = [];
  if (!help.trim()) throw new Error("CLI help output is empty");
  const positionals = parsePositionals(lines);
  const flags = parseFlags(lines, warnings);
  const usageIndex = lines.findIndex((line) => /^Usage:\s*\S/i.test(line));
  if (usageIndex >= 0) {
    const prefix = [basename(binary), ...path].join(" ");
    for (let index = usageIndex + 1; index < lines.length; index += 1) {
      const line = lines[index]?.trim() ?? "";
      if (!line) break;
      if (line.startsWith(prefix)) {
        warnings.push(
          "Multiple Usage forms found; verify positional arguments for the selected subcommand",
        );
        break;
      }
    }
  }
  if (!positionals.length)
    warnings.push("No positional arguments detected; verify the generated tuple");
  if (Object.values(flags).some((flag) => flag.kind !== "boolean" && !flag.repeatable))
    warnings.push("Help may omit which valued flags can repeat; review repeatable flag metadata");
  const descriptor: CommandDescriptor = {
    program: binary,
    path,
    positionals,
    flags,
    helpHash: createHash("sha256").update(help).digest("hex"),
  };
  return { descriptor, warnings };
}

export function renderCommandSource(name: string, descriptor: CommandDescriptor): string {
  const reserved = new Set([
    "await",
    "break",
    "case",
    "catch",
    "class",
    "const",
    "continue",
    "debugger",
    "default",
    "delete",
    "do",
    "else",
    "enum",
    "export",
    "extends",
    "false",
    "finally",
    "for",
    "function",
    "if",
    "import",
    "in",
    "instanceof",
    "new",
    "null",
    "return",
    "super",
    "switch",
    "this",
    "throw",
    "true",
    "try",
    "typeof",
    "var",
    "void",
    "while",
    "with",
    "yield",
  ]);
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) || reserved.has(name))
    throw new Error(`'${name}' is not a valid TypeScript identifier`);
  return (
    `import { type CommandDescriptor, defineCommand } from "loopy";\n\n` +
    `const descriptor = ${JSON.stringify(descriptor, null, 2)} as const satisfies CommandDescriptor;\n\n` +
    `export const ${name} = defineCommand(descriptor);\n`
  );
}

async function outputOf(binary: string, args: string[]): Promise<string> {
  try {
    const result = await execFileAsync(binary, args, {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 1_048_576,
    });
    return `${result.stdout}\n${result.stderr}`.trim();
  } catch (error) {
    const processError = error as Error & { stdout?: string; stderr?: string };
    const output = `${processError.stdout ?? ""}\n${processError.stderr ?? ""}`.trim();
    if (output) return output;
    throw new Error(`Could not run ${binary} ${args.join(" ")}: ${processError.message}`);
  }
}

export async function generateCommand(
  binary: string,
  path: string[],
  options: { name?: string } = {},
): Promise<{ source: string; help: string; warnings: string[] }> {
  const help = await outputOf(binary, [...path, "--help"]);
  const version = await outputOf(binary, ["--version"]).catch(() => "unknown");
  const parsed = parseCliHelp(binary, path, help);
  const name = options.name ?? identifier([basename(binary), ...path].join("-"));
  const descriptor = { ...parsed.descriptor, observedVersion: version.split("\n")[0] ?? version };
  return {
    source: renderCommandSource(name, descriptor),
    help,
    warnings: parsed.warnings,
  };
}
