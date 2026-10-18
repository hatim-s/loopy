import { isRecord, isString, type Json } from "../core/index.js";

export function redactValue(input: Json, redact: (text: string) => string): Json {
  if (isString(input)) {
    return redact(input);
  }

  if (Array.isArray(input)) {
    return input.map((item) => redactValue(item, redact));
  }

  if (isRecord(input)) {
    return Object.fromEntries(
      Object.entries(input).map(([key, item]) => [redact(key), redactValue(item, redact)]),
    );
  }

  return input;
}

export const REDACTED = "[redacted]";

/**
 * One character of a secret and every way it can appear in captured text. Authors can nest JSON
 * inside JSON strings to any depth, so `"`, `\` and control characters may sit behind any number
 * of backslashes.
 */
type Unit =
  | { kind: "literal"; char: string }
  | { kind: "quote" }
  | { kind: "backslash" }
  | { kind: "control"; raw: string; escape: string };

function units(secret: string): Unit[] {
  return [...secret].map((char): Unit => {
    if (char === '"') {
      return { kind: "quote" };
    }

    if (char === "\\") {
      return { kind: "backslash" };
    }

    const escaped = JSON.stringify(char).slice(1, -1);

    return escaped === char
      ? { kind: "literal", char }
      : { kind: "control", raw: char, escape: escaped.slice(1) };
  });
}

const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function unitPattern(unit: Unit): string {
  switch (unit.kind) {
    case "literal":
      return literal(unit.char);
    case "quote":
      return '\\\\*"';
    case "backslash":
      return "\\\\+";
    case "control":
      return `(?:${literal(unit.raw)}|\\\\+${unit.escape})`;
  }
}

/** Phase 0 starts a unit, -1 follows at least one backslash, n > 0 counts escape letters read. */
type Thread = { index: number; phase: number; start: number };

/** Phase after one more character of a control unit, or "done" once the unit is complete. */
function controlPhase(
  unit: Extract<Unit, { kind: "control" }>,
  phase: number,
  char: string,
): number | "done" | undefined {
  if (phase === 0 && char === unit.raw) {
    return "done";
  }

  if (phase <= 0 && char === "\\") {
    return -1;
  }

  const read = Math.max(phase, 0);

  if (phase !== 0 && char === unit.escape[read]) {
    return read + 1 === unit.escape.length ? "done" : read + 1;
  }

  return undefined;
}

function advance(secret: Unit[], { index, phase, start }: Thread, char: string): Thread[] {
  const unit = secret[index];
  const next = (to: number, at = 0) => ({ index: to, phase: at, start });

  switch (unit?.kind) {
    case undefined:
      return [];
    case "literal":
      return char === unit.char ? [next(index + 1)] : [];
    case "quote":
      return char === "\\" ? [next(index, -1)] : char === '"' ? [next(index + 1)] : [];
    case "backslash":
      // A run of backslashes may end the unit at any length, so both continuations stay open.
      return char === "\\" ? [next(index, -1), next(index + 1)] : [];
    case "control": {
      const moved = controlPhase(unit, phase, char);

      return moved === undefined ? [] : [moved === "done" ? next(index + 1) : next(index, moved)];
    }
  }
}

/**
 * Earliest offset from which the text is a cut-off encoding of the secret, at any escape depth.
 * Threads are simulated together instead of compiled into one nested regex, whose depth would
 * grow with the secret length.
 */
function trailingSecretStart(text: string, secret: Unit[]): number {
  let threads: Thread[] = [];
  let position = 0;

  for (const char of text) {
    const opened = advance(secret, { index: 0, phase: 0, start: position }, char);
    position += char.length;

    if (threads.length === 0 && opened.length === 0) {
      continue;
    }

    const moves = [...threads.flatMap((thread) => advance(secret, thread, char)), ...opened];
    threads = [];

    for (const moved of moves) {
      const same = threads.find(
        (thread) => thread.index === moved.index && thread.phase === moved.phase,
      );

      // Earlier starts win because they mask the longer cut-off tail.
      if (!same) {
        threads.push(moved);
      }
    }
  }

  return Math.min(text.length, ...threads.map((thread) => thread.start));
}

/**
 * Masks every secret at any JSON escape depth. Truncated output also masks a secret prefix at the
 * stream boundary, since a killed process can stop mid-write.
 */
export function secretRedactor(values: string[]) {
  const secrets = [...new Set(values)]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
    .map(units);

  const pattern = secrets.length
    ? new RegExp(secrets.map((secret) => secret.map(unitPattern).join("")).join("|"), "g")
    : undefined;

  const complete = (text: string) => (pattern ? text.replace(pattern, REDACTED) : text);

  const fragment = (text: string) => {
    const cut = Math.min(
      text.length,
      ...secrets.map((secret) => trailingSecretStart(text, secret)),
    );

    const head = complete(text.slice(0, cut));

    return cut < text.length ? `${head}${REDACTED}` : head;
  };

  return { complete, fragment };
}

export type Redactor = ReturnType<typeof secretRedactor>;
