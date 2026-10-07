import type { ParsedCliArgs } from "./args.js";

export type CliContext = {
  home: string;
  cwd: string;
  values: ParsedCliArgs["values"];
  /** Positional arguments after the command name. */
  positionals: string[];
  triggerInput: Record<string, string> | undefined;
};

export function requireArgument(value: string | undefined, label: string): string {
  if (!value) {
    throw new Error(`${label} is required. Run loopy --help for usage.`);
  }
  return value;
}

export function expectNoArguments(context: CliContext): void {
  if (context.positionals.length) {
    throw new Error(`Unexpected arguments: ${context.positionals.join(" ")}.`);
  }
}

/** The one positional a command accepts, or undefined when it was left out. */
export function optionalTarget(context: CliContext): string | undefined {
  const [target, ...extra] = context.positionals;
  if (extra.length) {
    throw new Error(`Unexpected arguments: ${extra.join(" ")}.`);
  }
  return target;
}

export function requireTarget(context: CliContext, label: string): string {
  return requireArgument(optionalTarget(context), label);
}
