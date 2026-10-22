import type { SourceRange } from "./view-models.ts";

export type TokenKind = "plain" | "keyword" | "string" | "number" | "comment" | "call";

export type Token = { kind: TokenKind; text: string };

const KEYWORDS = new Set([
  "as",
  "async",
  "await",
  "const",
  "default",
  "else",
  "export",
  "false",
  "for",
  "from",
  "function",
  "if",
  "import",
  "let",
  "new",
  "null",
  "of",
  "return",
  "true",
  "type",
  "undefined",
]);

// One pass per line: comments, strings, numbers, then words. A word before "(" is a call.
const TOKEN =
  /(\/\/.*$)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\b\d[\d_.]*\b)|([A-Za-z_$][\w$]*)(?=\s*\()|([A-Za-z_$][\w$]*)/g;

// Capture groups of TOKEN in order. A call or word that is a keyword reads as a keyword.
const GROUPS = ["comment", "string", "number", "call", "plain"] as const satisfies TokenKind[];

function kindOf(match: RegExpMatchArray): TokenKind {
  for (const [index, kind] of GROUPS.entries()) {
    if (match[index + 1] !== undefined) {
      return (kind === "call" || kind === "plain") && KEYWORDS.has(match[0]) ? "keyword" : kind;
    }
  }

  return "plain";
}

/**
 * Splits one line into coloured tokens. It reads a line at a time, so a string or comment that
 * spans lines colours only its first line. That is a display shortcut, not a parse.
 */
export function tokenize(line: string): Token[] {
  const tokens: Token[] = [];
  let last = 0;

  for (const match of line.matchAll(TOKEN)) {
    if (match.index > last) {
      tokens.push({ kind: "plain", text: line.slice(last, match.index) });
    }

    tokens.push({ kind: kindOf(match), text: match[0] });
    last = match.index + match[0].length;
  }

  if (last < line.length) {
    tokens.push({ kind: "plain", text: line.slice(last) });
  }

  return tokens;
}

/**
 * For each line, the innermost node range that covers it, or null. Innermost means the
 * shortest range, so a node inside a map's block wins over the map itself.
 */
export function lineOwners(lineCount: number, ranges: SourceRange[]): (SourceRange | null)[] {
  const owners: (SourceRange | null)[] = Array.from({ length: lineCount }, () => null);
  const ordered = [...ranges].sort((a, b) => b.endLine - b.startLine - (a.endLine - a.startLine));

  for (const range of ordered) {
    for (
      let line = Math.max(1, range.startLine);
      line <= Math.min(lineCount, range.endLine);
      line += 1
    ) {
      owners[line - 1] = range;
    }
  }

  return owners;
}
