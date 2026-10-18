import {
  CommandArgumentError,
  type CommandFlagSpec,
  renderOperands,
  validateCommandFlag,
} from "../../core/index.js";
import {
  type CommandDefinition,
  type CommandDescriptor,
  parsedFlags,
  platformVariant,
} from "../define-command.js";
import { type AuthorValue, isRef, type RefValue } from "./ref.js";

import { refuse } from "./validate.js";

type Input = {
  args?: readonly (string | RefValue)[];
  revisions?: readonly (string | RefValue)[];
  paths?: readonly (string | RefValue)[];
  flags?: Readonly<Record<string, AuthorValue>>;
};

function flagSpec(descriptor: CommandDefinition): CommandFlagSpec {
  return {
    path: [...(descriptor.path ?? [])],
    flags: { ...descriptor.flags },
    style: descriptor.style ?? "space",
    positionalSeparator: Boolean(descriptor.positionalSeparator && !descriptor.revisionPaths),
    flagsAfterPositionals: descriptor.flagsAfterPositionals ?? false,
  };
}

export function commandArgv(original: CommandDescriptor, input: Input, mode: "parsed" | "raw") {
  const descriptor = platformVariant(
    mode === "raw" ? (original.raw ?? original) : original,
    process.platform,
  );

  const key = original.key;

  const args =
    mode === "parsed" && !input.args?.length ? (descriptor.defaultArgs ?? input.args) : input.args;

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

    try {
      validateCommandFlag(flag, value, isRef);
    } catch (error) {
      if (error instanceof CommandArgumentError) {
        refuse(error.code, error.message);
      }

      throw error;
    }
  }

  const operands = {
    ...descriptor,
    positionals:
      mode === "parsed"
        ? (descriptor.parsedPositionals ?? descriptor.positionals)
        : descriptor.positionals,
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
}
