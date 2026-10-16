import type { CommandResult, Json } from "../../../core/index.js";
import { jsonValue, lines, unexpected } from "./shared.js";

export type Wc = { lines: number; words: number; bytes: number; file?: string };

export type UniqCount = { count: number; line: string };

export type Grep = { file: string | null; line: number; text: string };

export type GrepCount = number;

export type Sha256 = { hash: string; file: string };

export type Jq = Json;

export function parseWc({ stdout }: CommandResult): Wc[] {
  return lines(stdout).flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)(?:[ \t]+(.*))?$/.exec(line);

    if (!match || match.slice(1, 4).some((value) => !Number.isSafeInteger(Number(value)))) {
      unexpected("wc", line);
    }

    const entry = { lines: Number(match[1]), words: Number(match[2]), bytes: Number(match[3]) };

    if (match[4] === "total") {
      return [];
    }

    return [match[4] === undefined ? entry : { ...entry, file: match[4] }];
  });
}

export function parseUniqCount({ stdout }: CommandResult): UniqCount[] {
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

export function parseGrep({ stdout, exitCode }: CommandResult): Grep[] {
  if (exitCode === 1) {
    return [];
  }

  return lines(stdout).map((line) => {
    const single = /^(\d+):([\s\S]*)$/.exec(line);

    if (single) {
      return { file: null, line: grepLine(single[1] ?? "", line), text: single[2] ?? "" };
    }

    const match = /^(.*?):(\d+):([\s\S]*)$/.exec(line);

    if (!match) {
      unexpected("grep", line);
    }

    return { file: match[1] ?? null, line: grepLine(match[2] ?? "", line), text: match[3] ?? "" };
  });
}

export function parseGrepCount({ stdout }: CommandResult): GrepCount {
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

export function parseSha256({ stdout }: CommandResult): Sha256[] {
  return lines(stdout).map((line) => {
    const match = /^(\\?)([a-fA-F0-9]{64}) [ *](.+)$/.exec(line);

    if (!match?.[2] || !match[3]) {
      unexpected("sha256sum", line);
    }

    return { hash: match[2].toLowerCase(), file: checksumPath(match[3], match[1] === "\\", line) };
  });
}

export function parseJq({ stdout }: CommandResult): Jq {
  const values = lines(stdout).map((line) => jsonValue(line, "jq"));

  return values.length === 1 ? (values[0] ?? null) : values;
}
