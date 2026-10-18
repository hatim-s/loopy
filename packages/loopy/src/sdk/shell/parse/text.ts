import type { Json, RawCommandOutput } from "../../../core/index.js";
import type { CommandOperands } from "../../define-command.js";
import type { Infer } from "../../graph/types.js";
import { jsonValue, lines, unexpected } from "./shared.js";

type Wc = { lines: number; words: number; bytes: number; file?: string };

type UniqCount = { count: number; line: string };

type GrepMatch = { file: string | null; line: number; text: string };

type Grep = { matches: GrepMatch[]; binaryMatches: string[] };

type GrepCount = number;

type Sha256 = { hash: string; file: string };

type Jq = Json;

export function parseWc({ stdout }: RawCommandOutput, input: CommandOperands<string> = {}): Wc[] {
  const rows = lines(stdout);

  if ((input.args?.length ?? 0) > 1) {
    rows.pop();
  }

  return rows.map((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)(?:[ \t]+(.*))?$/.exec(line);

    if (!match || match.slice(1, 4).some((value) => !Number.isSafeInteger(Number(value)))) {
      unexpected("wc", line);
    }

    const entry = { lines: Number(match[1]), words: Number(match[2]), bytes: Number(match[3]) };

    return match[4] === undefined ? entry : { ...entry, file: match[4] };
  });
}

export function parseUniqCount({ stdout }: RawCommandOutput): UniqCount[] {
  return lines(stdout).map((line) => {
    const match = /^\s*(\d+) ([\s\S]*)$/.exec(line);

    if (!match || !Number.isSafeInteger(Number(match[1])) || Number(match[1]) < 1) {
      unexpected("uniq", line);
    }

    return { count: Number(match[1]), line: match[2] ?? "" };
  });
}

function grepLine(value: string, line: string): number {
  const number = Number(value);

  if (!Number.isSafeInteger(number) || number < 1) {
    unexpected("grep", line);
  }

  return number;
}

function parseGrepMatch(line: string): GrepMatch {
  const single = /^(\d+):([\s\S]*)$/.exec(line);

  if (single) {
    return { file: null, line: grepLine(single[1] ?? "", line), text: single[2] ?? "" };
  }

  const match = /^(.*?):(\d+):([\s\S]*)$/.exec(line);

  if (!match) {
    unexpected("grep", line);
  }

  return { file: match[1] ?? null, line: grepLine(match[2] ?? "", line), text: match[3] ?? "" };
}

export function parseGrep({ stdout, exitCode }: RawCommandOutput): Grep {
  const result: Grep = { matches: [], binaryMatches: [] };

  if (exitCode === 1) {
    return result;
  }

  for (const line of lines(stdout)) {
    const binary = /^Binary file (.+) matches$/.exec(line);

    if (binary?.[1]) {
      result.binaryMatches.push(binary[1]);
      continue;
    }

    result.matches.push(parseGrepMatch(line));
  }

  return result;
}

export function parseGrepCount({ stdout }: RawCommandOutput): GrepCount {
  const value = stdout.trim();

  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
    unexpected("grep", stdout);
  }

  return Number(value);
}

function checksumPath(path: string, escaped: boolean, line: string): string {
  if (!escaped) {
    return path;
  }

  let decoded = "";

  for (let index = 0; index < path.length; index++) {
    const char = path[index];

    if (char !== "\\") {
      decoded += char;
      continue;
    }

    const escape = path[++index];

    if (escape !== "n" && escape !== "r" && escape !== "\\") {
      unexpected("sha256sum", line);
    }

    decoded += escape === "n" ? "\n" : escape === "r" ? "\r" : "\\";
  }

  return decoded;
}

export function parseSha256({ stdout }: RawCommandOutput): Sha256[] {
  return lines(stdout).map((line) => {
    const match = /^(\\?)([a-fA-F0-9]{64}) [ *](.+)$/.exec(line);

    if (!match?.[2] || !match[3]) {
      unexpected("sha256sum", line);
    }

    return { hash: match[2].toLowerCase(), file: checksumPath(match[3], match[1] === "\\", line) };
  });
}

export function parseJq({ stdout }: RawCommandOutput): Jq {
  const values = lines(stdout).map((line) => jsonValue(line, "jq"));

  return values.length === 1 ? (values[0] ?? null) : values;
}

export const parseGrepCountOut = { kind: "value", type: "number" } as const;

parseGrepCount satisfies (raw: RawCommandOutput) => Infer<typeof parseGrepCountOut>;

export const parseWcOut = { kind: "value", type: "json[]" } as const;

parseWc satisfies (raw: RawCommandOutput) => Infer<typeof parseWcOut>;

export const parseUniqCountOut = { kind: "value", type: "json[]" } as const;

parseUniqCount satisfies (raw: RawCommandOutput) => Infer<typeof parseUniqCountOut>;

export const parseSha256Out = { kind: "value", type: "json[]" } as const;

parseSha256 satisfies (raw: RawCommandOutput) => Infer<typeof parseSha256Out>;

export const parseJqOut = { kind: "value", type: "json" } as const;

parseJq satisfies (raw: RawCommandOutput) => Infer<typeof parseJqOut>;

export const parseGrepOut = {
  kind: "record",
  fields: { matches: "json[]", binaryMatches: "string[]" },
} as const;

parseGrep satisfies (raw: RawCommandOutput) => Infer<typeof parseGrepOut>;
