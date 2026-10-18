import type { DiagnosticCode } from "./diagnostics.js";
import type { CommandFlag, CommandFlagSpec } from "./graph.js";
import { isBoolean, isNumber, isRecord, isString } from "./validation.js";

type CommandDefinition = Partial<Omit<CommandFlagSpec, "path" | "flags">> & {
  readonly path?: readonly string[];
  readonly flags?: Readonly<Record<string, CommandFlag>>;
};

export class CommandArgumentError extends Error {
  constructor(
    readonly code: Extract<DiagnosticCode, "unknown_flag" | "flag_type" | "flag_choice" | "arity">,
    message: string,
  ) {
    super(message);
    this.name = "CommandArgumentError";
  }
}

type RenderValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | readonly RenderValue[]
  | { readonly [key: string]: RenderValue };

type ResolvedCommandInput = {
  args?: readonly string[];
  flags?: Readonly<Record<string, RenderValue>>;
};

type Scalar = string | number | boolean;

export type FlagArgument<R = never> =
  | { form: "scalar"; value: Scalar | R }
  | { form: "pairs"; value: Readonly<Record<string, string | R>> }
  | { form: "repeated"; value: readonly (Scalar | R)[] };

type IsReference<R> = (value: unknown) => value is R;

// Resolved run-time values hold no references, and nothing is an instance of this private class.
class Unresolvable {}

const NO_REFERENCES: IsReference<never> = (value): value is never => value instanceof Unresolvable;

function flagType(flag: CommandFlag, detail: string) {
  return new CommandArgumentError("flag_type", `Flag '${flag.cli}' requires ${detail}.`);
}

function choice(flag: CommandFlag, value: string) {
  if ("choices" in flag && flag.choices && !flag.choices.includes(value)) {
    throw new CommandArgumentError(
      "flag_choice",
      `Flag '${flag.cli}' must be one of: ${flag.choices.join(", ")}. Choose an allowed value.`,
    );
  }

  return value;
}

function typedScalar<T>(flag: CommandFlag, value: T): Scalar {
  if (value === false && flag.kind === "boolean") {
    return false;
  }

  if (flag.supported === false) {
    throw new CommandArgumentError(
      "unknown_flag",
      `Flag '${flag.cli}' is unavailable on this platform. Use sh.exec with a platform-specific alternative.`,
    );
  }

  if (
    value === true &&
    (flag.kind === "boolean" || ("optionalValue" in flag && flag.optionalValue))
  ) {
    return true;
  }

  switch (flag.kind) {
    case "string":
      if (isString(value)) {
        return choice(flag, value);
      }

      break;
    case "number":
      if (isNumber(value) && Number.isFinite(value)) {
        return value;
      }

      break;
    case "boolean":
      if (isBoolean(value)) {
        return value;
      }
  }

  throw flagType(flag, `a ${flag.kind} value. Supply the declared flag type`);
}

function scalar<T, R>(flag: CommandFlag, value: T, isReference: IsReference<R>): Scalar | R {
  return isReference(value) ? value : typedScalar(flag, value);
}

/**
 * Checks a flag value against its declaration and returns it in render form. The SDK passes its
 * reference guard so unresolved refs pass through; null means there is nothing to render yet.
 */
export function validateCommandFlag<T, R = never>(
  flag: CommandFlag,
  value: T,
  isReference: IsReference<R> = NO_REFERENCES,
): FlagArgument<R> | null {
  if (value === undefined || isReference(value)) {
    return null;
  }

  if (flag.style === "pairs") {
    if (!isRecord(value)) {
      throw flagType(flag, "named values. Supply a record of strings");
    }

    const pairs = Object.entries(value).map(([key, item]) => {
      if (!isString(item) && !isReference(item)) {
        throw flagType(flag, "string values. Supply a record of strings");
      }

      return [key, item] as const;
    });

    return { form: "pairs", value: Object.fromEntries(pairs) };
  }

  if (flag.style === "terminated" || ("repeatable" in flag && flag.repeatable)) {
    if (!Array.isArray(value) || (flag.style === "terminated" && value.length === 0)) {
      throw flagType(flag, "an array of values");
    }

    return { form: "repeated", value: value.map((item) => scalar(flag, item, isReference)) };
  }

  return { form: "scalar", value: scalar(flag, value, isReference) };
}

function tokens(flag: CommandFlag, value: Scalar, style: CommandDefinition["style"]) {
  if (value === false && flag.kind === "boolean") {
    return [];
  }

  if (
    value === true &&
    (flag.kind === "boolean" || ("optionalValue" in flag && flag.optionalValue))
  ) {
    return [flag.cli];
  }

  const format = flag.style ?? style ?? "space";

  if (format === "positional") {
    return [String(value)];
  }

  if (format === "space") {
    return [flag.cli, String(value)];
  }

  return [`${flag.cli}${format === "equals" ? "=" : ""}${value}`];
}

function renderFlag(
  flag: CommandFlag,
  value: RenderValue,
  style: CommandDefinition["style"],
): string[] {
  const argument = validateCommandFlag(flag, value);

  switch (argument?.form) {
    case undefined:
      return [];
    case "pairs":
      return Object.entries(argument.value).flatMap(([key, item]) => [flag.cli, key, item]);
    case "repeated":
      if (flag.style === "terminated") {
        return [flag.cli, ...argument.value.map(String), flag.terminator];
      }

      return argument.value.flatMap((item) => tokens(flag, item, style));
    case "scalar": {
      const result = tokens(flag, argument.value, style);

      return result.length ? [...(flag.prefix ?? []), ...result] : [];
    }
  }
}

function buildFlags(descriptor: CommandDefinition, input: ResolvedCommandInput) {
  const before: string[] = [];
  const after: string[] = [];

  const flags = Object.entries(descriptor.flags ?? {}).sort(
    ([, a], [, b]) => (a.order ?? 0) - (b.order ?? 0),
  );

  for (const [name, flag] of flags) {
    const value = input.flags?.[name];

    const target =
      (flag.position ?? (descriptor.flagsAfterPositionals ? "after" : "before")) === "after"
        ? after
        : before;

    target.push(...renderFlag(flag, value, descriptor.style));
  }

  return { before, after };
}

export function renderArgv(descriptor: CommandDefinition, input: ResolvedCommandInput): string[] {
  const flags = buildFlags(descriptor, input);
  const operands = input.args ?? [];

  const separator = descriptor.positionalSeparator && operands.length ? ["--"] : [];

  return [...(descriptor.path ?? []), ...flags.before, ...separator, ...operands, ...flags.after];
}
