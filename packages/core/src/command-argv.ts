import type { CommandSpec } from "./executor";
import type { CommandFlag, CommandFlagSpec } from "./graph";
import type { Json } from "./json";

/** Graph construction defers checks of reference values until execution resolves them. */
type Deferred<V> = (value: V) => boolean;

// BOUNDARY: Flag values come from author modules at build time and from resolved references at execution.
function flagTokens<V>(
  flag: CommandFlag,
  value: V,
  style: CommandFlagSpec["style"],
  deferred: Deferred<V>,
): string[] {
  if (value === undefined || (value === false && flag.kind === "boolean") || deferred(value)) {
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

function formatValue(flag: CommandFlag, value: string, style: CommandFlagSpec["style"]): string[] {
  const format = flag.style ?? style;

  if (format === "positional") {
    return [value];
  }

  if (format === "space") {
    return [flag.cli, value];
  }

  return [`${flag.cli}${format === "equals" ? "=" : ""}${value}`];
}

// BOUNDARY: Named flag values must be a record of strings once references resolve.
function namedPairs<V>(flag: CommandFlag, value: V, deferred: Deferred<V>): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Flag '${flag.cli}' requires named values. Supply a record of strings.`);
  }

  const tokens: string[] = [];

  for (const [key, item] of Object.entries(value)) {
    if (deferred(item)) {
      continue;
    }

    if (typeof item !== "string") {
      throw new Error(`Flag '${flag.cli}' requires string values. Supply a record of strings.`);
    }

    tokens.push(flag.cli, key, item);
  }

  return tokens;
}

function repeatedTokens<V>(
  flag: CommandFlag,
  value: V,
  style: CommandFlagSpec["style"],
  deferred: Deferred<V>,
): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`Flag '${flag.cli}' is repeatable. Supply an array of values.`);
  }

  const items: readonly V[] = value;

  if (flag.terminator) {
    if (!items.length) {
      throw new Error(`Flag '${flag.cli}' requires arguments. Supply a nonempty array of strings.`);
    }

    const tokens = items.flatMap((item) =>
      flagTokens({ ...flag, style: "positional" }, item, style, deferred),
    );

    return [flag.cli, ...tokens, flag.terminator];
  }

  return items.flatMap((item) => flagTokens(flag, item, style, deferred));
}

function renderFlag<V>(
  flag: CommandFlag,
  value: V | undefined,
  style: CommandFlagSpec["style"],
  deferred: Deferred<V>,
): string[] {
  if (value === undefined || deferred(value)) {
    return [];
  }

  if (flag.pairs) {
    return namedPairs(flag, value, deferred);
  }

  if (flag.repeatable) {
    return repeatedTokens(flag, value, style, deferred);
  }

  const tokens = flagTokens(flag, value, style, deferred);

  return tokens.length ? [...(flag.prefix ?? []), ...tokens] : [];
}

function renderFlags<V>(
  spec: CommandFlagSpec | null,
  values: Readonly<Record<string, V>>,
  deferred: Deferred<V>,
) {
  const allowed = spec?.flags ?? {};

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
      (flag.position ?? (spec?.flagsAfterPositionals ? "after" : "before")) === "after"
        ? after
        : before;

    target.push(...renderFlag(flag, values[name], spec?.style ?? "space", deferred));
  }

  return { before, after };
}

/**
 * Rejects unknown flags and invalid literal values while a graph is built. Flag support depends on
 * the executing host, so only rendering at execution rejects an unsupported flag.
 */
export function checkCommandFlags<V>(
  spec: CommandFlagSpec,
  flags: Readonly<Record<string, V>>,
  deferred: Deferred<V>,
): void {
  const portable = Object.fromEntries(
    Object.entries(spec.flags).map(([name, flag]) => [name, { ...flag, supported: true }]),
  );

  renderFlags({ ...spec, flags: portable }, flags, deferred);
}

/** A command node without a flag spec accepts no flags. */
function renderCommandArgv(
  spec: CommandFlagSpec | null,
  operands: readonly string[],
  flags: Readonly<Record<string, Json>>,
): string[] {
  const rendered = renderFlags(spec, flags, () => false);
  const separator = spec?.positionalSeparator && operands.length ? ["--"] : [];

  return [...(spec?.path ?? []), ...rendered.before, ...separator, ...operands, ...rendered.after];
}

/** Renders argv with the executing platform's variant, or the base declaration without one. */
export function renderCommand(spec: CommandSpec, platform: string): [string, ...string[]] {
  const [program, ...operands] = spec.argv;

  const variant =
    platform === "darwin" || platform === "linux" ? spec.variants[platform] : undefined;

  if (variant === undefined) {
    return [program, ...renderCommandArgv(spec.flagSpec, operands, spec.flags)];
  }

  return [
    variant.program,
    ...renderCommandArgv(variant.flagSpec, operands, { ...spec.flags, ...variant.preset }),
  ];
}
