import type { CommandResult } from "../../../core/index.js";

export type Change = {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed" | "copied" | "typechange";
  from?: string;
};

export type Conflict = { path: string; status: string };

export type Status = {
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  staged: Change[];
  unstaged: Change[];
  untracked: string[];
  conflicts: Conflict[];
  stashes: number;
};

export type LogEntry = {
  sha: string;
  short: string;
  author: { name: string; email: string };
  date: string;
  subject: string;
  body: string;
};

export type DiffEntry = {
  path: string;
  added: number | null;
  deleted: number | null;
  from?: string;
};

export type DiffName = { path: string; status: string; from?: string };

export type Branch = {
  name: string;
  current: boolean;
  upstream: string | null;
  sha: string;
  ahead: number;
  behind: number;
};

export type Worktree = {
  path: string;
  sha: string | null;
  branch: string | null;
  bare: boolean;
  detached: boolean;
  locked: boolean;
  lockReason?: string;
  prunable?: string;
};

export type Stash = { ref: string; sha: string; message: string };

export type Tag = { name: string; sha: string; date: string | null };

export type Remote = { name: string; fetch: string | null; push: string | null };

const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

const CHANGE_STATUSES = {
  A: "added",
  M: "modified",
  D: "deleted",
  R: "renamed",
  C: "copied",
  T: "typechange",
} as const;

function unexpected(cmd: string, line: string): never {
  throw new Error(`Unexpected git ${cmd} output line: ${line}. Report this with the git version.`);
}

function lines(stdout: string): string[] {
  return stdout === "" ? [] : stdout.replace(/\n$/, "").split("\n");
}

function nulFields(stdout: string, cmd: string): string[] {
  if (stdout === "") {
    return [];
  }

  if (!stdout.endsWith("\0")) {
    unexpected(cmd, stdout);
  }

  return stdout.slice(0, -1).split("\0");
}

function required(value: string | undefined, cmd: string, line: string): string {
  if (!value) {
    unexpected(cmd, line);
  }

  return value;
}

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

function addChange(target: Change[], code: string, path: string, from?: string) {
  if (code === ".") {
    return;
  }

  if (!Object.hasOwn(CHANGE_STATUSES, code)) {
    unexpected("status", `${code} ${path}`);
  }

  // SAFETY: The own-key check above narrows the porcelain status to the declared map.
  const status = CHANGE_STATUSES[code as keyof typeof CHANGE_STATUSES];
  target.push(from && (code === "R" || code === "C") ? { path, status, from } : { path, status });
}

function statusHeader(result: Status, line: string) {
  const stash = /^# stash (\d+)$/.exec(line);

  if (stash) {
    result.stashes = Number(stash[1]);

    return;
  }

  statusBranchHeader(result, line);
}

function statusBranchHeader(result: Status, line: string) {
  if (line.startsWith("# branch.oid ")) {
    const oid = line.slice(13);

    if (oid !== "(initial)" && !SHA.test(oid)) {
      unexpected("status", line);
    }

    return;
  }

  if (line.startsWith("# branch.head ")) {
    const branch = required(line.slice(14), "status", line);
    result.branch = branch === "(detached)" ? null : branch;

    return;
  }

  if (line.startsWith("# branch.upstream ")) {
    result.upstream = required(line.slice(18), "status", line);

    return;
  }

  const ab = /^# branch.ab \+(\d+) -(\d+)$/.exec(line);

  if (!ab) {
    unexpected("status", line);
  }

  result.ahead = Number(ab[1]);
  result.behind = Number(ab[2]);
}

function statusRecord(result: Status, line: string, from?: string) {
  const match = /^(1|2|u) ([.AMDRCTU]{2}) (N\.\.\.|S[.C][.M][.U]) ([\s\S]*)$/.exec(line);

  if (!match) {
    unexpected("status", line);
  }

  const count = match[1] === "u" ? 7 : match[1] === "2" ? 6 : 5;
  const fields = required(match[4], "status", line).split(" ");
  const metadata = fields.splice(0, count);
  const path = required(fields.join(" "), "status", line);
  const modes = match[1] === "u" ? 4 : 3;

  if (
    metadata.length !== count ||
    metadata.slice(0, modes).some((mode) => !/^[0-7]{6}$/.test(mode)) ||
    metadata.slice(modes, modes + (match[1] === "u" ? 3 : 2)).some((sha) => !SHA.test(sha))
  ) {
    unexpected("status", line);
  }

  const xy = required(match[2], "status", line);

  if (match[1] === "u") {
    result.conflicts.push({ path, status: xy });

    return;
  }

  if (match[1] === "2" && (!from || !/^[RC]\d+$/.test(metadata[5] ?? ""))) {
    unexpected("status", line);
  }

  addChange(result.staged, xy.charAt(0), path, from);
  addChange(result.unstaged, xy.charAt(1), path, from);
}

export function parseStatus({ stdout }: CommandResult): Status {
  const result: Status = {
    branch: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    staged: [],
    unstaged: [],
    untracked: [],
    conflicts: [],
    stashes: 0,
  };

  const fields = nulFields(stdout, "status");

  for (let index = 0; index < fields.length; index++) {
    const line = required(fields[index], "status", stdout);

    if (line.startsWith("# ")) {
      statusHeader(result, line);
    } else if (line.startsWith("? ")) {
      result.untracked.push(required(line.slice(2), "status", line));
    } else if (line.startsWith("! ")) {
      required(line.slice(2), "status", line);
    } else {
      const from = line.startsWith("2 ") ? required(fields[++index], "status", line) : undefined;
      statusRecord(result, line, from);
    }
  }

  return result;
}

// NUL cannot appear in a valid git commit message. Seven fields per record keep blank
// lines and even ASCII record-separator bytes in bodies intact; -z terminates each record.
export const LOG_FORMAT = "%H%x00%h%x00%an%x00%ae%x00%aI%x00%s%x00%b";

export function parseLog({ stdout }: CommandResult): LogEntry[] {
  const fields = nulFields(stdout, "log");

  if (fields.length % 7 !== 0) {
    unexpected("log", stdout);
  }

  const result: LogEntry[] = [];

  for (let index = 0; index < fields.length; index += 7) {
    const [sha = "", short = "", name = "", email = "", date = "", subject = "", body = ""] =
      fields.slice(index, index + 7);

    if (
      !SHA.test(sha) ||
      !/^[a-f0-9]+$/.test(short) ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d$/.test(date)
    ) {
      unexpected("log", fields.slice(index, index + 7).join("\0"));
    }

    result.push({ sha, short, author: { name, email }, date, subject, body });
  }

  return result;
}

function diffPaths(fields: string[], index: number, path: string, cmd: string) {
  if (path) {
    return { entry: { path }, consumed: 0 };
  }

  const from = required(fields[index + 1], cmd, fields.join("\0"));
  const to = required(fields[index + 2], cmd, fields.join("\0"));

  return { entry: { path: to, from }, consumed: 2 };
}

export function parseDiff({ stdout }: CommandResult): DiffEntry[] {
  const fields = nulFields(stdout, "diff");
  const result: DiffEntry[] = [];

  for (let index = 0; index < fields.length; index++) {
    const line = required(fields[index], "diff", stdout);
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(line);

    if (!match || (match[1] === "-") !== (match[2] === "-")) {
      unexpected("diff", line);
    }

    const { entry, consumed } = diffPaths(fields, index, match[3] ?? "", "diff");
    result.push({
      ...entry,
      added: match[1] === "-" ? null : Number(match[1]),
      deleted: match[2] === "-" ? null : Number(match[2]),
    });
    index += consumed;
  }

  return result;
}

export function parseDiffNames({ stdout }: CommandResult): DiffName[] {
  const fields = nulFields(stdout, "diffNames");
  const result: DiffName[] = [];

  for (let index = 0; index < fields.length; index += 2) {
    const status = required(fields[index], "diffNames", stdout);

    if (!/^(?:[ACDMRTUXB]|[RC]\d+|M\d+)$/.test(status)) {
      unexpected("diffNames", status);
    }

    const path = required(fields[index + 1], "diffNames", status);

    if (/^[RC]/.test(status)) {
      result.push({ status, from: path, path: required(fields[index + 2], "diffNames", status) });
      index++;
    } else {
      result.push({ status, path });
    }
  }

  return result;
}

export function parseBranch({ stdout }: CommandResult): Branch[] {
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
      unexpected("branch", line);
    }

    return {
      name,
      current: head === "*",
      upstream: upstream || null,
      sha,
      ...tracking(track, "branch", line),
    };
  });
}

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
    unexpected("worktree.list", line);
  }

  const body = value.slice(1, -1);
  const bytes: number[] = [];
  let cursor = 0;

  for (const match of body.matchAll(/\\([0-7]{3}|[abfnrtv"\\])|([^"\\]+)/g)) {
    if (match.index !== cursor) {
      unexpected("worktree.list", line);
    }

    const escape = match[1];

    if (escape) {
      bytes.push(
        escape.length === 3
          ? Number.parseInt(escape, 8)
          : (C_ESCAPES.get(escape) ?? unexpected("worktree.list", line)),
      );
    } else {
      bytes.push(...new TextEncoder().encode(match[2]));
    }

    cursor += match[0].length;
  }

  if (cursor !== body.length) {
    unexpected("worktree.list", line);
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

  unexpected("worktree.list", line);
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

export function parseWorktreeList({ stdout }: CommandResult): Worktree[] {
  if (!stdout) {
    return [];
  }

  return stdout
    .replace(/\n+$/, "")
    .split("\n\n")
    .map((block) => {
      const [first = "", ...rest] = block.split("\n");

      if (!first.startsWith("worktree ") || !first.slice(9)) {
        unexpected("worktree.list", first);
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
        unexpected("worktree.list", block);
      }

      return entry;
    });
}

export function parseStashList({ stdout }: CommandResult): Stash[] {
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
      unexpected("stash.list", line);
    }

    return { ref, sha, message };
  });
}

export function parseTag({ stdout }: CommandResult): Tag[] {
  return lines(stdout).map((line) => {
    const [name, sha, date, extra] = line.split("\0");

    if (
      !name ||
      !sha ||
      !SHA.test(sha) ||
      date === undefined ||
      extra !== undefined ||
      (date !== "" && !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d$/.test(date))
    ) {
      unexpected("tag", line);
    }

    return { name, sha, date: date || null };
  });
}

export function parseRemote({ stdout }: CommandResult): Remote[] {
  const remotes = new Map<string, Remote>();

  for (const line of lines(stdout)) {
    const match = /^(\S+)\t(.+) \((fetch|push)\)$/.exec(line);

    if (!match) {
      unexpected("remote", line);
    }

    const name = required(match[1], "remote", line);
    const entry = remotes.get(name) ?? { name, fetch: null, push: null };

    if (match[3] === "fetch") {
      entry.fetch = required(match[2], "remote", line);
    } else {
      entry.push = required(match[2], "remote", line);
    }

    remotes.set(name, entry);
  }

  return [...remotes.values()];
}

export type RevParse = string;

export function parseRevParse({ stdout }: CommandResult): RevParse {
  const value = stdout.trim();

  if (!value || /[\n\r\0]/.test(value)) {
    unexpected("rev-parse", stdout);
  }

  return value;
}

export type LsFiles = string[];

export function parseLsFiles({ stdout }: CommandResult): LsFiles {
  return nulFields(stdout, "ls-files").map((path) => required(path, "ls-files", stdout));
}
