import { parseArgs } from "node:util";

const options = {
  help: { type: "boolean", short: "h" },
  home: { type: "string" },
  cwd: { type: "string" },
  input: { type: "string" },
  args: { type: "string" },
  full: { type: "boolean" },
  out: { type: "string" },
  origin: { type: "string" },
  name: { type: "string" },
  port: { type: "string" },
  "retry-uncertain": { type: "boolean" },
  force: { type: "boolean" },
  replace: { type: "boolean" },
} as const;

export function parseCliArgs(args: string[]) {
  const cli: string[] = [];
  const entries: [string, string][] = [];
  let inputsOnly = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === undefined) break;
    if (arg === "--") {
      if (parseArgs({ args: cli, options, allowPositionals: true }).positionals[0] !== "run") {
        cli.push(...args.slice(index));
        break;
      }
      inputsOnly = true;
      continue;
    }
    const equals = arg.indexOf("=");
    const name = arg.slice(2, equals < 0 ? undefined : equals);
    const option = Object.hasOwn(options, name) ? options[name as keyof typeof options] : undefined;
    if (!inputsOnly && (!arg.startsWith("--") || option)) {
      cli.push(arg);
      if (arg.startsWith("--") && option?.type === "string" && equals < 0) {
        const value = args[++index];
        if (value === undefined || value.startsWith("--"))
          throw new Error(`Option --${name} requires a value.`);
        cli.push(value);
      }
      continue;
    }
    if (!arg.startsWith("--") || !name)
      throw new Error(`Expected a trigger input flag, received '${arg}'.`);
    if (entries.some(([key]) => key === name))
      throw new Error(`Trigger input --${name} was provided more than once.`);
    const value = equals < 0 ? args[++index] : arg.slice(equals + 1);
    if (value === undefined || (equals < 0 && value.startsWith("--")))
      throw new Error(
        `Trigger input --${name} requires a value. Use --${name}=value for a value starting with --.`,
      );
    entries.push([name, value]);
  }
  const parsed = parseArgs({ args: cli, options, allowPositionals: true, strict: true });
  if (parsed.positionals[0] !== "run" && (entries.length || parsed.values.args !== undefined))
    throw new Error("Trigger input flags and --args are only supported by loopy run.");
  const sources =
    Number(entries.length > 0) +
    Number(parsed.values.args !== undefined) +
    Number(parsed.values.input !== undefined);
  if (sources > 1) throw new Error("Choose one input source: named flags, --args, or --input.");
  return { ...parsed, triggerInput: entries.length ? Object.fromEntries(entries) : undefined };
}
