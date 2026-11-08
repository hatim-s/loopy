import { type CommandFlagSpec, checkCommandFlags } from "@loopy/core";
import {
  type CommandDefinition,
  type CommandDescriptor,
  type CommandOperands,
  commandKey,
  type PositionalDefinition,
  type Prepare,
  parsedFlags,
  platformVariant,
} from "../descriptor";
import { type AuthorValue, RefValue } from "./ref";

export type CommandArguments = CommandOperands<string | RefValue, AuthorValue>;

function flagSpec(descriptor: CommandDefinition): CommandFlagSpec {
  return {
    path: [...(descriptor.path ?? [])],
    flags: { ...descriptor.flags },
    style: descriptor.style ?? "space",
    positionalSeparator: Boolean(descriptor.positionalSeparator && !descriptor.revisionPaths),
    flagsAfterPositionals: descriptor.flagsAfterPositionals ?? false,
  };
}

function checkArity(
  positionals: readonly PositionalDefinition[] | undefined,
  args: readonly unknown[],
  key: string,
) {
  if (!positionals) {
    return;
  }

  const minimum = positionals.filter((part) => !part.optional).length;
  const maximum = positionals.some((part) => part.variadic) ? Infinity : positionals.length;

  if (args.length < minimum || args.length > maximum) {
    const count = maximum === Infinity ? `at least ${minimum}` : `${minimum} to ${maximum}`;
    throw new Error(
      `Command '${key}' expected ${count} positional arguments. Supply args with the expected count.`,
    );
  }
}

function operands(descriptor: CommandDefinition, input: CommandArguments) {
  const args = input.args ?? [];

  if (!descriptor.revisionPaths) {
    return [...args];
  }

  return [
    ...args,
    ...(input.revisions ?? []),
    ...(input.paths?.length ? ["--", ...input.paths] : []),
  ];
}

/** Validates author operands and flags with the rules the executor applies to resolved values. */
export function commandArgv(
  original: CommandDescriptor,
  input: CommandArguments,
  mode: { kind: "raw" } | { kind: "parsed"; prepare?: Prepare },
) {
  const descriptor = platformVariant(original, process.platform);
  const key = commandKey(original);
  const flags = mode.kind === "parsed" ? parsedFlags(descriptor, input) : (input.flags ?? {});
  const unprepared = { ...input, flags };
  const prepared = mode.kind === "parsed" && mode.prepare ? mode.prepare(unprepared) : unprepared;
  const spec = flagSpec(descriptor);

  checkArity(
    mode.kind === "parsed"
      ? (descriptor.parsedPositionals ?? descriptor.positionals)
      : descriptor.positionals,
    prepared.args ?? [],
    key,
  );
  checkCommandFlags(spec, prepared.flags ?? {}, (value) => value instanceof RefValue);

  return {
    key,
    program: descriptor.program,
    operands: operands(descriptor, prepared),
    flags: prepared.flags ?? {},
    flagSpec: spec,
    okExitCodes: original.okExitCodes ?? [0],
    parseInput: Object.fromEntries(
      Object.entries(prepared).filter(([, value]) => value !== undefined),
    ),
  };
}
