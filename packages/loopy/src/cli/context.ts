import { Effect } from "effect";
import type { ParsedCliArgs } from "./args.js";
import { CliError } from "./errors.js";

export type CliContext = {
  home: string;
  leaseMs?: number;
  cwd: string;
  values: ParsedCliArgs["values"];
  /** Positional arguments after the command name. */
  positionals: string[];
  namedInput: Record<string, string> | undefined;
};

export const requireArgument = Effect.fn(function* (value: string | undefined, label: string) {
  if (!value) {
    return yield* Effect.fail(
      new CliError({ message: `${label} is required. Run loopy --help for usage.` }),
    );
  }

  return value;
});

export const expectNoArguments = (context: CliContext) =>
  context.positionals.length
    ? Effect.fail(
        new CliError({ message: `Unexpected arguments: ${context.positionals.join(" ")}.` }),
      )
    : Effect.void;

export const optionalTarget = Effect.fn(function* (context: CliContext) {
  const [target, ...extra] = context.positionals;

  if (extra.length) {
    return yield* Effect.fail(
      new CliError({ message: `Unexpected arguments: ${extra.join(" ")}.` }),
    );
  }

  return target;
});

export const requireTarget = Effect.fn(function* (context: CliContext, label: string) {
  return yield* requireArgument(yield* optionalTarget(context), label);
});

export const requireHead = Effect.fn(function* (context: CliContext, label: string) {
  const [head, ...rest] = context.positionals;

  return { head: yield* requireArgument(head, label), rest };
});
