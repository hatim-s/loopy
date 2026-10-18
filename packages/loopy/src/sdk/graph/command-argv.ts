import {
  CommandArgumentError,
  type CommandFlagSpec,
  validateCommandFlag,
} from "../../core/index.js";
import {
  type CommandDefinition,
  type CommandDescriptor,
  type CommandOperands,
  parsedFlags,
  platformVariant,
} from "../define-command.js";
import { isRef, type RefValue } from "./ref.js";

import { refuse } from "./validate.js";

function flagSpec(descriptor: CommandDefinition): CommandFlagSpec {
  return {
    path: [...(descriptor.path ?? [])],
    flags: { ...descriptor.flags },
    style: descriptor.style ?? "space",
    positionalSeparator:
      descriptor.operands?.kind === "positional" && descriptor.operands.separator,
    flagsAfterPositionals: descriptor.flagsAfterPositionals ?? false,
  };
}

export function commandArgv(
  original: CommandDescriptor,
  input: CommandOperands<string | RefValue>,
  { key, mode }: { key: string; mode: "parsed" | "raw" },
) {
  try {
    const descriptor = platformVariant(
      mode === "raw" ? (original.raw ?? original) : original,
      process.platform,
    );

    const args =
      mode === "parsed" && !input.args?.length
        ? (descriptor.defaultArgs ?? input.args)
        : input.args;

    const flags = mode === "parsed" ? parsedFlags(descriptor, input) : input.flags;
    const prepared = { ...input, args, flags: { ...flags } };

    if (mode === "parsed") {
      const counts = {
        args: args?.length ?? 0,
        flags: new Set(
          Object.entries(prepared.flags)
            .filter(([, value]) => value !== undefined)
            .map(([name]) => name),
        ),
      };

      Object.assign(prepared.flags, descriptor.prepare?.(counts).flags);
    }

    for (const [name, value] of Object.entries(prepared.flags)) {
      const flag = descriptor.flags?.[name];

      if (!flag) {
        refuse(
          "unknown_flag",
          `Unknown flag '${name}'. Use an allowed flag: ${Object.keys(descriptor.flags ?? {}).join(", ") || "none"}.`,
        );
      }

      validateCommandFlag(flag, value, isRef);
    }

    return {
      parseInput: Object.fromEntries(
        Object.entries(prepared).filter(([, value]) => value !== undefined),
      ),
      program: descriptor.program,
      argv: renderOperands(descriptor, prepared, key),
      flagSpec: flagSpec(descriptor),
      flags: prepared.flags,
    };
  } catch (error) {
    if (error instanceof CommandArgumentError) {
      refuse(error.code, error.message);
    }

    throw error;
  }
}

function renderOperands<T>(
  descriptor: CommandDefinition,
  input: CommandOperands<T>,
  key: string,
): (T | string)[] {
  const args = input.args ?? [];
  const operands = descriptor.operands;

  if (operands?.kind === "revisionPaths") {
    return [...(input.revisions ?? []), ...(input.paths?.length ? ["--", ...input.paths] : [])];
  }

  if (operands?.parts) {
    const minimum = operands.parts.filter((part) => !part.optional).length;
    const maximum = operands.parts.some((part) => part.variadic) ? Infinity : operands.parts.length;

    if (args.length < minimum || args.length > maximum) {
      refuse(
        "arity",
        `Command '${key}' expects ${maximum === Infinity ? `at least ${minimum}` : `${minimum} to ${maximum}`} positional arguments.`,
      );
    }
  }

  return [...args];
}
