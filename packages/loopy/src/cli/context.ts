import type { ParsedCliArgs } from "./args.js";
import { DaemonError } from "./errors.js";

export type CliContext = {
  home: string;
  cwd: string;
  values: ParsedCliArgs["values"];
  /** Positional arguments after the command name. */
  positionals: string[];
  namedInput: Record<string, string> | undefined;
};

export function requireArgument(value: string | undefined, label: string): string {
  if (!value) {
    throw new DaemonError("bad_request", `${label} is required. Run loopy --help for usage.`);
  }

  return value;
}

export function expectNoArguments(context: CliContext): void {
  if (context.positionals.length) {
    throw new DaemonError("bad_request", `Unexpected arguments: ${context.positionals.join(" ")}.`);
  }
}

export function optionalTarget(context: CliContext): string | undefined {
  const [target, ...extra] = context.positionals;

  if (extra.length) {
    throw new DaemonError("bad_request", `Unexpected arguments: ${extra.join(" ")}.`);
  }

  return target;
}

export function requireTarget(context: CliContext, label: string): string {
  return requireArgument(optionalTarget(context), label);
}

export function requireHead(context: CliContext, label: string) {
  const [head, ...rest] = context.positionals;

  return { head: requireArgument(head, label), rest };
}
