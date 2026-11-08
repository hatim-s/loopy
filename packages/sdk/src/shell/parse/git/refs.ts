import type { ParserInput } from "@loopy/core";
import { lines, nulFields, unexpected } from "../shared";
import { ISO_DATE, required, SHA } from "./shared";

type Branch = {
  name: string;
  current: boolean;
  upstream: string | null;
  sha: string;
  ahead: number;
  behind: number;
};

type Stash = { ref: string; sha: string; message: string };

type Tag = { name: string; sha: string; date: string | null };

type Remote = { name: string; fetch: string | null; push: string | null };

function tracking(value: string, cmd: string, line: string) {
  if (!value || value === "[gone]") {
    return { ahead: 0, behind: 0 };
  }

  const match = /^\[(?:ahead (\d+))?(?:, )?(?:behind (\d+))?\]$/.exec(value);

  if (!match || (!match[1] && !match[2])) {
    unexpected(cmd, line);
  }

  return { ahead: Number(match[1] ?? 0), behind: Number(match[2] ?? 0) };
}

export function parseBranch({ stdout }: ParserInput): Branch[] {
  return lines(stdout).map((line) => {
    const [name, head, upstream, sha, track, extra] = line.split("\0");

    if (
      !name ||
      (head !== "*" && head !== " ") ||
      upstream === undefined ||
      !sha ||
      !SHA.test(sha) ||
      track === undefined ||
      extra !== undefined
    ) {
      unexpected("git branch", line);
    }

    return {
      name,
      current: head === "*",
      upstream: upstream || null,
      sha,
      ...tracking(track, "git branch", line),
    };
  });
}

export function parseStashList({ stdout }: ParserInput): Stash[] {
  return lines(stdout).map((line) => {
    const [ref, sha, message, extra] = line.split("\0");

    if (
      !ref ||
      !/^stash@\{\d+\}$/.test(ref) ||
      !sha ||
      !SHA.test(sha) ||
      message === undefined ||
      extra !== undefined
    ) {
      unexpected("git stash.list", line);
    }

    return { ref, sha, message };
  });
}

export function parseTag({ stdout }: ParserInput): Tag[] {
  return lines(stdout).map((line) => {
    const [name, sha, date, extra] = line.split("\0");

    if (
      !name ||
      !sha ||
      !SHA.test(sha) ||
      date === undefined ||
      extra !== undefined ||
      (date !== "" && !ISO_DATE.test(date))
    ) {
      unexpected("git tag", line);
    }

    return { name, sha, date: date || null };
  });
}

export function parseRemote({ stdout }: ParserInput): Remote[] {
  const remotes = new Map<string, Remote>();

  for (const line of lines(stdout)) {
    const match = /^(\S+)\t(.+) \((fetch|push)\)$/.exec(line);

    if (!match) {
      unexpected("git remote", line);
    }

    const name = required(match[1], "git remote", line);
    const entry = remotes.get(name) ?? { name, fetch: null, push: null };

    if (match[3] === "fetch") {
      entry.fetch = required(match[2], "git remote", line);
    } else {
      entry.push = required(match[2], "git remote", line);
    }

    remotes.set(name, entry);
  }

  return [...remotes.values()];
}

export function parseRevParse({ stdout }: ParserInput): string {
  const value = stdout.trim();

  if (!value || /[\n\r\0]/.test(value)) {
    unexpected("git rev-parse", stdout);
  }

  return value;
}

export function parseLsFiles({ stdout }: ParserInput): string[] {
  return nulFields(stdout, "git ls-files").map((path) => required(path, "git ls-files", stdout));
}
