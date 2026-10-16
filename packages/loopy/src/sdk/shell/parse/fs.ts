import type { CommandResult } from "../../../core/index.js";
import { jsonValue, lines, nulFields, unexpected } from "./shared.js";

export type Find = string[];

export type Ls = string[];

export type Stat = {
  path: string;
  size: number;
  mtime: string;
  type: "file" | "directory" | "symlink" | "other";
  mode: string;
};

export type Du = { path: string; kilobytes: number };

export type Df = {
  filesystem: string;
  kilobytes: number;
  used: number;
  available: number;
  capacity: number;
  mountedOn: string;
};

export type Realpath = string;

export type Which = string | null;

export type Mktemp = string;

export type TreeNode = { type: "directory" | "file"; name: string; contents?: TreeNode[] };

export type Tree = TreeNode[];

// Neither BSD -f nor GNU -c interprets git's %x00. SOH separates metadata fields.
export const STAT_DARWIN_FORMAT = "%N\x01%z\x01%m\x01%HT\x01%Lp";

export const STAT_LINUX_FORMAT = "%n\x01%s\x01%Y\x01%F\x01%a";

export function parseFind({ stdout }: CommandResult): Find {
  return nulFields(stdout, "find").map((path) => path || unexpected("find", stdout));
}

export function parseLs(result: CommandResult): Ls {
  return nulFields(result.stdout, "ls").map(
    (path) => (path || unexpected("ls", result.stdout)).replace(/\/$/, "").split("/").at(-1) ?? "",
  );
}

function statType(value: string): Stat["type"] {
  switch (value.toLowerCase()) {
    case "regular file":
    case "regular empty file":
      return "file";
    case "directory":
      return "directory";
    case "symbolic link":
      return "symlink";
    default:
      return "other";
  }
}

export function parseStat({ stdout }: CommandResult): Stat[] {
  const entries: Stat[] = [];
  let cursor = 0;
  const records = /([\s\S]*?)\x01(\d+)\x01(-?\d+)\x01([^\x01\n]+)\x01([0-7]{1,4})\n/g;

  for (const match of stdout.matchAll(records)) {
    const [line, path = "", size = "", seconds = "", type = "", mode = ""] = match;
    const date = new Date(Number(seconds) * 1000);

    if (
      match.index !== cursor ||
      !path ||
      !Number.isSafeInteger(Number(size)) ||
      !Number.isFinite(date.getTime())
    ) {
      unexpected("stat", line);
    }

    entries.push({
      path,
      size: Number(size),
      mtime: date.toISOString(),
      type: statType(type),
      mode,
    });
    cursor += line.length;
  }

  if (cursor !== stdout.length) {
    unexpected("stat", stdout.slice(cursor));
  }

  return entries;
}

export function parseDu({ stdout }: CommandResult): Du[] {
  return lines(stdout).map((line) => {
    const match = /^(\d+)\t(.+)$/.exec(line);

    if (!match?.[2] || !Number.isSafeInteger(Number(match[1]))) {
      unexpected("du", line);
    }

    return { path: match[2], kilobytes: Number(match[1]) };
  });
}

export function parseDf({ stdout }: CommandResult): Df[] {
  const [header = "", ...rows] = lines(stdout);

  if (
    !/^Filesystem\s+(?:1024-blocks|1K-blocks)\s+Used\s+Available\s+(?:Capacity|Use%)\s+Mounted on$/.test(
      header,
    )
  ) {
    unexpected("df", header);
  }

  return rows.map((line) => {
    const match = /^(.*?)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)%\s+(.+)$/.exec(line);

    if (
      !match?.[1] ||
      !match[6] ||
      match.slice(2, 6).some((value) => !Number.isSafeInteger(Number(value)))
    ) {
      unexpected("df", line);
    }

    return {
      filesystem: match[1],
      kilobytes: Number(match[2]),
      used: Number(match[3]),
      available: Number(match[4]),
      capacity: Number(match[5]),
      mountedOn: match[6],
    };
  });
}

function trimmed(stdout: string, command: string): string {
  return stdout.trim() || unexpected(command, stdout);
}

export function parseRealpath({ stdout }: CommandResult): Realpath {
  return trimmed(stdout, "realpath");
}

export function parseWhich({ stdout, exitCode }: CommandResult): Which {
  return exitCode === 1 ? null : trimmed(stdout, "which");
}

export function parseMktemp({ stdout }: CommandResult): Mktemp {
  return trimmed(stdout, "mktemp");
}

// BOUNDARY: tree JSON is untrusted command output; validate each recursive node here.
function treeNode(value: ReturnType<typeof jsonValue>, line: string): TreeNode {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (value.type !== "file" && value.type !== "directory" && value.type !== "link") ||
    typeof value.name !== "string"
  ) {
    unexpected("tree", line);
  }

  if (value.contents === undefined) {
    return { type: value.type === "directory" ? "directory" : "file", name: value.name };
  }

  if (!Array.isArray(value.contents) || value.type !== "directory") {
    unexpected("tree", line);
  }

  return {
    type: value.type,
    name: value.name,
    contents: value.contents.map((node) => treeNode(node, line)),
  };
}

export function parseTree({ stdout }: CommandResult): Tree {
  const value = jsonValue(stdout, "tree");

  if (!Array.isArray(value)) {
    unexpected("tree", stdout);
  }

  return value.map((node) => treeNode(node, stdout));
}
