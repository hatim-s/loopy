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

type Phase = { kind: "start" } | { kind: "escaped" } | { kind: "letters"; read: number };

type Thread = { index: number; phase: Phase; start: number };

const START: Phase = { kind: "start" };

const ESCAPED: Phase = { kind: "escaped" };

const samePhase = (a: Phase, b: Phase) =>
  a.kind === b.kind && (a.kind !== "letters" || (b.kind === "letters" && a.read === b.read));

function controlPhase(
  unit: Extract<Unit, { kind: "control" }>,
  phase: Phase,
  char: string,
): Phase | "done" | undefined {
  if (phase.kind === "start" && char === unit.raw) {
    return "done";
  }

  if (phase.kind !== "letters" && char === "\\") {
    return ESCAPED;
  }

  const read = phase.kind === "letters" ? phase.read : 0;

  if (phase.kind !== "start" && char === unit.escape[read]) {
    return read + 1 === unit.escape.length ? "done" : { kind: "letters", read: read + 1 };
  }

  return undefined;
}

function advance(secret: Unit[], { index, phase, start }: Thread, char: string): Thread[] {
  const unit = secret[index];
  const next = (to: number, at = START) => ({ index: to, phase: at, start });

  switch (unit?.kind) {
    case undefined:
      return [];
    case "literal":
      return char === unit.char ? [next(index + 1)] : [];
    case "quote":
      return char === "\\" ? [next(index, ESCAPED)] : char === '"' ? [next(index + 1)] : [];
    case "backslash":
      // A run of backslashes may end the unit at any length, so both continuations stay open.
      return char === "\\" ? [next(index, ESCAPED), next(index + 1)] : [];
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
    const opened = advance(secret, { index: 0, phase: START, start: position }, char);
    position += char.length;

    if (threads.length === 0 && opened.length === 0) {
      continue;
    }

    const moves = [...threads.flatMap((thread) => advance(secret, thread, char)), ...opened];
    threads = [];

    for (const moved of moves) {
      const same = threads.find(
        (thread) => thread.index === moved.index && samePhase(thread.phase, moved.phase),
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

  return (text: string, truncated = false): string => {
    const cut = truncated
      ? Math.min(text.length, ...secrets.map((secret) => trailingSecretStart(text, secret)))
      : text.length;

    const head = pattern ? text.slice(0, cut).replace(pattern, REDACTED) : text.slice(0, cut);

    return cut < text.length ? `${head}${REDACTED}` : head;
  };
}
