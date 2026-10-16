import type { CommandDefinition, FlagDefinition } from "./define-command.js";

// BOUNDARY: JavaScript command inputs are checked against descriptor flags and arity below.
export type RenderInput = {
  args?: readonly string[];
  revisions?: readonly string[];
  paths?: readonly string[];
  flags?: Readonly<Record<string, unknown>>;
};

// BOUNDARY: JavaScript callers supply untyped flag values at this public API.
function flagTokens(
  flag: FlagDefinition,
  value: unknown,
  style: CommandDefinition["style"],
): string[] {
  if (value === undefined || (value === false && flag.kind === "boolean")) {
    return [];
  }

  if (flag.supported === false) {
    throw new Error(
      `Flag '${flag.cli}' is unavailable on this platform. Use sh.exec with a platform-specific alternative.`,
    );
  }

  if (value === true && (flag.kind === "boolean" || flag.optionalValue)) {
    return [flag.cli];
  }

  if (typeof value !== flag.kind || (typeof value === "number" && !Number.isFinite(value))) {
    throw new Error(
      `Flag '${flag.cli}' requires a ${flag.kind} value. Supply the declared flag type.`,
    );
  }

  if (flag.choices && !flag.choices.includes(String(value))) {
    throw new Error(
      `Flag '${flag.cli}' must be one of: ${flag.choices.join(", ")}. Choose an allowed value.`,
    );
  }

  return formatValue(flag, String(value), style);
}

function formatValue(
  flag: FlagDefinition,
  value: string,
  style: CommandDefinition["style"],
): string[] {
  const format = flag.style ?? style ?? "space";

  if (format === "positional") {
    return [value];
  }

  if (format === "space") {
    return [flag.cli, value];
  }

  return [`${flag.cli}${format === "equals" ? "=" : ""}${value}`];
}

// BOUNDARY: JavaScript flag values are checked against their declared scalar, pair or array shape.
function renderFlag(
  flag: FlagDefinition,
  value: unknown,
  style: CommandDefinition["style"],
): string[] {
  if (value === undefined) {
    return [];
  }

  if (flag.pairs) {
    return namedPairs(flag, value);
  }

  if (flag.repeatable) {
    return repeatedTokens(flag, value, style);
  }

  const tokens = flagTokens(flag, value, style);

  return tokens.length ? [...(flag.prefix ?? []), ...tokens] : [];
}

// BOUNDARY: JavaScript named flag values must be an object containing string values.
function namedPairs(flag: FlagDefinition, value: unknown): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Flag '${flag.cli}' requires named values. Supply a record of strings.`);
  }

  const tokens: string[] = [];

  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string") {
      throw new Error(`Flag '${flag.cli}' requires string values. Supply a record of strings.`);
    }

    tokens.push(flag.cli, key, item);
  }

  return tokens;
}

// BOUNDARY: JavaScript repeated flag values must be arrays of the declared scalar type.
function repeatedTokens(
  flag: FlagDefinition,
  value: unknown,
  style: CommandDefinition["style"],
): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`Flag '${flag.cli}' is repeatable. Supply an array of values.`);
  }

  const items: readonly unknown[] = value;

  if (flag.terminator) {
    if (!items.length) {
      throw new Error(`Flag '${flag.cli}' requires arguments. Supply a nonempty array of strings.`);
    }

    const tokens = items.flatMap((item) =>
      flagTokens({ ...flag, style: "positional" }, item, style),
    );

    return [flag.cli, ...tokens, flag.terminator];
  }

  return items.flatMap((item) => flagTokens(flag, item, style));
}

// BOUNDARY: JavaScript callers can supply unknown flags and omit required operands.
function buildFlags(descriptor: CommandDefinition, values: Readonly<Record<string, unknown>>) {
  const allowed = descriptor.flags ?? {};

  for (const name of Object.keys(values)) {
    if (!Object.hasOwn(allowed, name)) {
      throw new Error(
        `Unknown flag '${name}'. Use an allowed flag: ${Object.keys(allowed).join(", ") || "none"}.`,
      );
    }
  }

  const before: string[] = [];
  const after: string[] = [];
  const flags = Object.entries(allowed).sort(([, a], [, b]) => (a.order ?? 0) - (b.order ?? 0));

  for (const [name, flag] of flags) {
    const target =
      (flag.position ?? (descriptor.flagsAfterPositionals ? "after" : "before")) === "after"
        ? after
        : before;

    target.push(...renderFlag(flag, values[name], descriptor.style));
  }

  return { before, after };
}

function validateArity(descriptor: CommandDefinition, args: readonly string[], key: string) {
  if (!descriptor.positionals) {
    return;
  }

  const minimum = descriptor.positionals.filter((part) => !part.optional).length;

  const maximum = descriptor.positionals.some((part) => part.variadic)
    ? Infinity
    : descriptor.positionals.length;

  if (args.length < minimum || args.length > maximum) {
    const count = maximum === Infinity ? `at least ${minimum}` : `${minimum} to ${maximum}`;
    throw new Error(
      `Command '${key}' expected ${count} positional arguments. Supply args with the expected count.`,
    );
  }
}

export function renderArgv(
  descriptor: CommandDefinition,
  input: RenderInput,
  key: string,
): string[] {
  const flags = buildFlags(descriptor, input.flags ?? {});
  const operands = input.args ?? [];
  validateArity(descriptor, operands, key);
  const args = [...(descriptor.path ?? []), ...flags.before];

  if (descriptor.revisionPaths) {
    args.push(...(input.revisions ?? []));

    if (input.paths?.length) {
      args.push("--", ...input.paths);
    }

    return [...args, ...flags.after];
  }

  if (descriptor.positionalSeparator && operands.length) {
    args.push("--");
  }

  return [...args, ...operands, ...flags.after];
}
