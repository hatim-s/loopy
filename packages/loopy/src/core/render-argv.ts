import type { DiagnosticCode } from "./diagnostics.js";
import type { CommandFlag, CommandFlagSpec, Value } from "./graph.js";
import { refs } from "./graph-values.js";
import { isBoolean, isNumber, isRecord, isString } from "./validation.js";

type CommandDefinition = Partial<Omit<CommandFlagSpec, "path" | "flags">> & {
  readonly path?: readonly string[];
  readonly flags?: Readonly<Record<string, CommandFlag>>;
  readonly program: string;
  readonly revisionPaths?: boolean;
  readonly positionals?: readonly { readonly optional?: boolean; readonly variadic?: boolean }[];
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

export type RenderInput = {
  args?: readonly string[];
  revisions?: readonly string[];
  paths?: readonly string[];
  flags?: Readonly<Record<string, RenderValue>>;
  references?: Readonly<Record<string, Value>>;
};

function scalar<T>(flag: CommandFlag, value: T, isReference: <R>(value: R) => boolean) {
  if (isReference(value) || value === undefined || (value === false && flag.kind === "boolean")) {
    return;
  }

  if (flag.supported === false) {
    throw new CommandArgumentError(
      "unknown_flag",
      `Flag '${flag.cli}' is unavailable on this platform. Use sh.exec with a platform-specific alternative.`,
    );
  }

  if (value === true && (flag.kind === "boolean" || flag.optionalValue)) {
    return;
  }

  if (
    !{ string: isString, number: isNumber, boolean: isBoolean }[flag.kind](value) ||
    (isNumber(value) && !Number.isFinite(value))
  ) {
    throw new CommandArgumentError(
      "flag_type",
      `Flag '${flag.cli}' requires a ${flag.kind} value. Supply the declared flag type.`,
    );
  }

  if (flag.choices && !flag.choices.includes(String(value))) {
    throw new CommandArgumentError(
      "flag_choice",
      `Flag '${flag.cli}' must be one of: ${flag.choices.join(", ")}. Choose an allowed value.`,
    );
  }
}

// BOUNDARY: Literal flags enter through the SDK; resolved reference values enter before dispatch.
export function validateCommandFlag<T>(
  flag: CommandFlag,
  value: T,
  isReference: <R>(value: R) => boolean = () => false,
): void {
  if (value === undefined || isReference(value)) {
    return;
  }

  if (flag.pairs) {
    if (!isRecord(value)) {
      throw new CommandArgumentError(
        "flag_type",
        `Flag '${flag.cli}' requires named values. Supply a record of strings.`,
      );
    }

    for (const item of Object.values(value)) {
      if (!isString(item) && !isReference(item)) {
        throw new CommandArgumentError(
          "flag_type",
          `Flag '${flag.cli}' requires string values. Supply a record of strings.`,
        );
      }
    }

    return;
  }

  if (flag.repeatable) {
    if (!Array.isArray(value) || (flag.terminator && value.length === 0)) {
      throw new CommandArgumentError(
        "flag_type",
        `Flag '${flag.cli}' requires an array of values.`,
      );
    }

    for (const item of value) {
      scalar(flag, item, isReference);
    }

    return;
  }

  scalar(flag, value, isReference);
}

type Scalar = string | number | boolean;

type FlagArgument =
  | { form: "scalar"; value: Scalar }
  | { form: "pairs"; value: Record<string, string> }
  | { form: "repeated"; value: readonly Scalar[] };

function tokens(flag: CommandFlag, value: Scalar, style: CommandDefinition["style"]) {
  if (value === false && flag.kind === "boolean") {
    return [];
  }

  if (value === true && (flag.kind === "boolean" || flag.optionalValue)) {
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
  if (value === undefined) {
    return [];
  }

  const form = flag.pairs ? "pairs" : flag.repeatable ? "repeated" : "scalar";
  // SAFETY: The SDK checked literals, and renderArgv checks resolved refs before formatting.
  const argument = { form, value } as FlagArgument;

  switch (argument.form) {
    case "pairs":
      return Object.entries(argument.value).flatMap(([key, item]) => [flag.cli, key, item]);
    case "repeated":
      if (flag.terminator) {
        return [flag.cli, ...argument.value.map(String), flag.terminator];
      }

      return argument.value.flatMap((item) => tokens(flag, item, style));
    case "scalar": {
      const result = tokens(flag, argument.value, style);

      return result.length ? [...(flag.prefix ?? []), ...result] : [];
    }
  }
}

function buildFlags(descriptor: CommandDefinition, input: RenderInput) {
  const before: string[] = [];
  const after: string[] = [];

  const flags = Object.entries(descriptor.flags ?? {}).sort(
    ([, a], [, b]) => (a.order ?? 0) - (b.order ?? 0),
  );

  for (const [name, flag] of flags) {
    const value = input.flags?.[name];

    if (refs(input.references?.[name] ?? null).length > 0) {
      validateCommandFlag(flag, value);
    }

    const target =
      (flag.position ?? (descriptor.flagsAfterPositionals ? "after" : "before")) === "after"
        ? after
        : before;

    target.push(...renderFlag(flag, value, descriptor.style));
  }

  return { before, after };
}

function validateArity<T>(descriptor: CommandDefinition, args: readonly T[], key: string) {
  if (!descriptor.positionals) {
    return;
  }

  const minimum = descriptor.positionals.filter((part) => !part.optional).length;

  const maximum = descriptor.positionals.some((part) => part.variadic)
    ? Infinity
    : descriptor.positionals.length;

  if (args.length < minimum || args.length > maximum) {
    const count = maximum === Infinity ? `at least ${minimum}` : `${minimum} to ${maximum}`;
    throw new CommandArgumentError(
      "arity",
      `Command '${key}' expected ${count} positional arguments. Supply args with the expected count.`,
    );
  }
}

export function renderArgv(
  descriptor: CommandDefinition,
  input: RenderInput,
  key: string,
): string[] {
  const flags = buildFlags(descriptor, input);
  const operands = renderOperands(descriptor, input, key);

  const separator =
    descriptor.positionalSeparator && operands.length && !descriptor.revisionPaths ? ["--"] : [];

  return [...(descriptor.path ?? []), ...flags.before, ...separator, ...operands, ...flags.after];
}

export function renderOperands<T>(
  descriptor: CommandDefinition,
  input: { args?: readonly T[]; revisions?: readonly T[]; paths?: readonly T[] },
  key: string,
): (T | string)[] {
  const operands = input.args ?? [];
  validateArity(descriptor, operands, key);

  if (descriptor.revisionPaths) {
    return [
      ...operands,
      ...(input.revisions ?? []),
      ...(input.paths?.length ? ["--", ...input.paths] : []),
    ];
  }

  return [...operands];
}
