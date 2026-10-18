import {
  CommandArgumentError,
  type CommandFlagSpec,
  renderOperands,
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
  mode: "parsed" | "raw",
) {
  try {
    const descriptor = platformVariant(
      mode === "raw" ? (original.raw ?? original) : original,
      process.platform,
    );

    const key = original.key;

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

    const operands = {
      ...descriptor,
      positionals:
        descriptor.operands?.kind === "positional" ? descriptor.operands.parts : undefined,
      revisionPaths: descriptor.operands?.kind === "revisionPaths",
    };

    return {
      parseInput: Object.fromEntries(
        Object.entries(prepared).filter(([, value]) => value !== undefined),
      ),
      program: descriptor.program,
      argv: renderOperands(operands, prepared, key),
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
