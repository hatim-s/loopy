import type { RawCommandOutput } from "../../../core/index.js";
import type { Infer } from "../../graph/types.js";
import { jsonValue, lines, nulFields, unexpected } from "./shared.js";

type Find = string[];

type Ls = string[];

type Stat = {
  path: string;
  size: number;
  mtime: string;
  type: "file" | "directory" | "symlink" | "other";
  mode: string;
};

type Du = { path: string; kilobytes: number };

type Df = {
  filesystem: string;
  kilobytes: number;
  used: number;
  available: number;
  capacity: number;
  mountedOn: string;
};

type Realpath = string;

type Which = string | null;

type Mktemp = string;

type TreeNode = { type: "directory" | "file"; name: string; contents?: TreeNode[] };

type Tree = TreeNode[];

// Neither BSD -f nor GNU -c interprets git's %x00. SOH separates metadata fields.
export const STAT_DARWIN_FORMAT = "%N\x01%z\x01%m\x01%HT\x01%Lp";

export const STAT_LINUX_FORMAT = "%n\x01%s\x01%Y\x01%F\x01%a";

export function parseFind({ stdout }: RawCommandOutput): Find {
  return nulFields(stdout, "find").map((path) => path || unexpected("find", stdout));
}

export function parseLs(result: RawCommandOutput): Ls {
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

export function parseStat({ stdout }: RawCommandOutput): Stat[] {
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

export function parseDu({ stdout }: RawCommandOutput): Du[] {
  return lines(stdout).map((line) => {
    const match = /^(\d+)\t(.+)$/.exec(line);

    if (!match?.[2] || !Number.isSafeInteger(Number(match[1]))) {
      unexpected("du", line);
    }

    return { path: match[2], kilobytes: Number(match[1]) };
  });
}

export function parseDf({ stdout }: RawCommandOutput): Df[] {
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

export function parseRealpath({ stdout }: RawCommandOutput): Realpath {
  return trimmed(stdout, "realpath");
}

export function parseWhich({ stdout, exitCode }: RawCommandOutput): Which {
  return exitCode === 1 ? null : trimmed(stdout, "which");
}

export function parseMktemp({ stdout }: RawCommandOutput): Mktemp {
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

export function parseTree({ stdout }: RawCommandOutput): Tree {
  const value = jsonValue(stdout, "tree");

  if (!Array.isArray(value)) {
    unexpected("tree", stdout);
  }

  return value.map((node) => treeNode(node, stdout));
}

export const parseStatOut = { kind: "value", type: "json[]" } as const;

parseStat satisfies (raw: RawCommandOutput) => Infer<typeof parseStatOut>;

export const parseFindOut = { kind: "value", type: "string[]" } as const;

parseFind satisfies (raw: RawCommandOutput) => Infer<typeof parseFindOut>;

export const parseWhichOut = { kind: "value", type: "json" } as const;

parseWhich satisfies (raw: RawCommandOutput) => Infer<typeof parseWhichOut>;

export const parseMktempOut = { kind: "value", type: "string" } as const;

parseMktemp satisfies (raw: RawCommandOutput) => Infer<typeof parseMktempOut>;

export const parseLsOut = { kind: "value", type: "string[]" } as const;

parseLs satisfies (raw: RawCommandOutput) => Infer<typeof parseLsOut>;

export const parseDuOut = { kind: "value", type: "json[]" } as const;

parseDu satisfies (raw: RawCommandOutput) => Infer<typeof parseDuOut>;

export const parseRealpathOut = { kind: "value", type: "string" } as const;

parseRealpath satisfies (raw: RawCommandOutput) => Infer<typeof parseRealpathOut>;

export const parseDfOut = { kind: "value", type: "json[]" } as const;

parseDf satisfies (raw: RawCommandOutput) => Infer<typeof parseDfOut>;

export const parseTreeOut = { kind: "value", type: "json[]" } as const;

parseTree satisfies (raw: RawCommandOutput) => Infer<typeof parseTreeOut>;
