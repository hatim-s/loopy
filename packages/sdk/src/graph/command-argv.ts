import {
  COMMAND_PLATFORMS,
  type CommandFlagSpec,
  type CommandVariant,
  checkCommandFlags,
} from "@loopy/core";
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

type Mode = { kind: "raw" } | { kind: "parsed"; prepare?: Prepare };

type RenderedCommand = {
  key: string;
  program: string;
  operands: (string | RefValue)[];
  flags: Readonly<Record<string, AuthorValue>>;
  flagSpec: CommandFlagSpec;
  variants: Partial<Record<(typeof COMMAND_PLATFORMS)[number], CommandVariant>>;
  okExitCodes: readonly number[];
  parseInput: Record<string, AuthorValue>;
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

const deferred = (value: AuthorValue) => value instanceof RefValue;

/** Each declared variant must accept the same author flags, since the executing host picks one. */
function variants(
  descriptor: CommandDescriptor,
  input: CommandArguments,
  flags: Readonly<Record<string, AuthorValue>>,
  mode: Mode,
): RenderedCommand["variants"] {
  return Object.fromEntries(
    COMMAND_PLATFORMS.flatMap((platform) => {
      if (descriptor.variants?.[platform] === undefined) {
        return [];
      }

      const definition = platformVariant(descriptor, platform);
      const spec = flagSpec(definition);
      const preset = mode.kind === "parsed" ? { ...definition.preset?.flags } : {};

      if (mode.kind === "parsed") {
        parsedFlags(definition, input);
      }

      checkCommandFlags(spec, { ...flags, ...preset }, deferred);

      return [[platform, { program: definition.program, flagSpec: spec, preset }]];
    }),
  );
}

/** Validates author operands and flags with the rules the executor applies to resolved values. */
export function commandArgv(
  descriptor: CommandDescriptor,
  input: CommandArguments,
  mode: Mode,
): RenderedCommand {
  const key = commandKey(descriptor);
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
  checkCommandFlags(spec, prepared.flags ?? {}, deferred);

  return {
    key,
    program: descriptor.program,
    operands: operands(descriptor, prepared),
    flags: prepared.flags ?? {},
    flagSpec: spec,
    variants: variants(descriptor, input, prepared.flags ?? {}, mode),
    okExitCodes: descriptor.okExitCodes ?? [0],
    parseInput: Object.fromEntries(
      Object.entries(prepared).filter(([, value]) => value !== undefined),
    ),
  };
}
