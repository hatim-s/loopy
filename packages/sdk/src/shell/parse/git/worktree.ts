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
      entry.lockReason = line.slice(7);
    }

    return;
  }

  if (line === "prunable" || line.startsWith("prunable ")) {
    entry.prunable = line.slice(9);

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

  if (!stdout.endsWith("\0\0")) {
    unexpected("git worktree.list", stdout);
  }

  return stdout
    .slice(0, -2)
    .split("\0\0")
    .map((block) => {
      const [first = "", ...rest] = block.split("\0");

      if (!first.startsWith("worktree ") || !first.slice(9)) {
        unexpected("git worktree.list", first);
      }

      const entry: Worktree = {
        path: first.slice(9),
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
