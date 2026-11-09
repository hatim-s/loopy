import type { ParserInput } from "@loopy/core";
import { unexpected } from "../shared";
import { SHA } from "./shared";

type Worktree = {
  path: string;
  sha: string | null;
  branch: string | null;
  bare: boolean;
  detached: boolean;
  locked: boolean;
  lockReason?: string;
  prunable?: string;
};

const C_ESCAPES = new Map([
  ["a", 7],
  ["b", 8],
  ["f", 12],
  ["n", 10],
  ["r", 13],
  ["t", 9],
  ["v", 11],
  ['"', 34],
  ["\\", 92],
]);

function worktreeValue(value: string, line: string): string {
  if (!value.startsWith('"')) {
    return value;
  }

  if (!value.endsWith('"')) {
    unexpected("git worktree.list", line);
  }

  const body = value.slice(1, -1);
  const bytes: number[] = [];
  let cursor = 0;

  for (const match of body.matchAll(/\\([0-7]{3}|[abfnrtv"\\])|([^"\\]+)/g)) {
    if (match.index !== cursor) {
      unexpected("git worktree.list", line);
    }

    const escape = match[1];

    if (escape) {
      bytes.push(
        escape.length === 3
          ? Number.parseInt(escape, 8)
          : (C_ESCAPES.get(escape) ?? unexpected("git worktree.list", line)),
      );
    } else {
      bytes.push(...new TextEncoder().encode(match[2]));
    }

    cursor += match[0].length;
  }

  if (cursor !== body.length) {
    unexpected("git worktree.list", line);
  }

  return new TextDecoder().decode(new Uint8Array(bytes));
}

function worktreeState(entry: Worktree, line: string) {
  if (line === "bare") {
    entry.bare = true;

    return;
  }

  if (line === "detached") {
    entry.detached = true;

    return;
  }

  if (line === "locked" || line.startsWith("locked ")) {
    entry.locked = true;

    if (line.length > 7) {
      entry.lockReason = worktreeValue(line.slice(7), line);
    }

    return;
  }

  if (line === "prunable" || line.startsWith("prunable ")) {
    entry.prunable = worktreeValue(line.slice(9), line);

    return;
  }

  unexpected("git worktree.list", line);
}

function worktreeField(entry: Worktree, line: string) {
  if (line.startsWith("HEAD ") && SHA.test(line.slice(5))) {
    entry.sha = line.slice(5);

    return;
  }

  if (line.startsWith("branch refs/")) {
    entry.branch = line.slice(7).replace(/^refs\/heads\//, "");

    return;
  }

  worktreeState(entry, line);
}

export function parseWorktreeList({ stdout }: ParserInput): Worktree[] {
  if (!stdout) {
    return [];
  }

  return stdout
    .replace(/\n+$/, "")
    .split("\n\n")
    .map((block) => {
      const [first = "", ...rest] = block.split("\n");

      if (!first.startsWith("worktree ") || !first.slice(9)) {
        unexpected("git worktree.list", first);
      }

      const entry: Worktree = {
        path: worktreeValue(first.slice(9), first),
        sha: null,
        branch: null,
        bare: false,
        detached: false,
        locked: false,
      };

      for (const line of rest) {
        worktreeField(entry, line);
      }

      if (!entry.bare && (!entry.sha || (!entry.branch && !entry.detached))) {
        unexpected("git worktree.list", block);
      }

      return entry;
    });
}
