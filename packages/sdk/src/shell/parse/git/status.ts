import type { ParserInput } from "@loopy/core";
import { nulFields, unexpected } from "../shared";
import { required, SHA } from "./shared";

type Change = {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed" | "copied" | "typechange";
  from?: string;
};

type Conflict = { path: string; status: string };

type Status = {
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

const CHANGE_STATUSES = new Map<string, Change["status"]>([
  ["A", "added"],
  ["M", "modified"],
  ["D", "deleted"],
  ["R", "renamed"],
  ["C", "copied"],
  ["T", "typechange"],
]);

function addChange(target: Change[], code: string, path: string, from?: string) {
  if (code === ".") {
    return;
  }

  const status = CHANGE_STATUSES.get(code) ?? unexpected("git status", `${code} ${path}`);
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
      unexpected("git status", line);
    }

    return;
  }

  if (line.startsWith("# branch.head ")) {
    const branch = required(line.slice(14), "git status", line);
    result.branch = branch === "(detached)" ? null : branch;

    return;
  }

  if (line.startsWith("# branch.upstream ")) {
    result.upstream = required(line.slice(18), "git status", line);

    return;
  }

  const ab = /^# branch.ab \+(\d+) -(\d+)$/.exec(line);

  if (!ab) {
    unexpected("git status", line);
  }

  result.ahead = Number(ab[1]);
  result.behind = Number(ab[2]);
}

function statusRecord(result: Status, line: string, from?: string) {
  const match = /^(1|2|u) ([.AMDRCTU]{2}) (N\.\.\.|S[.C][.M][.U]) ([\s\S]*)$/.exec(line);

  if (!match) {
    unexpected("git status", line);
  }

  const count = match[1] === "u" ? 7 : match[1] === "2" ? 6 : 5;
  const fields = required(match[4], "git status", line).split(" ");
  const metadata = fields.splice(0, count);
  const path = required(fields.join(" "), "git status", line);
  const modes = match[1] === "u" ? 4 : 3;

  if (
    metadata.length !== count ||
    metadata.slice(0, modes).some((mode) => !/^[0-7]{6}$/.test(mode)) ||
    metadata.slice(modes, modes + (match[1] === "u" ? 3 : 2)).some((sha) => !SHA.test(sha))
  ) {
    unexpected("git status", line);
  }

  const xy = required(match[2], "git status", line);

  if (match[1] === "u") {
    result.conflicts.push({ path, status: xy });

    return;
  }

  if (match[1] === "2" && (!from || !/^[RC]\d+$/.test(metadata[5] ?? ""))) {
    unexpected("git status", line);
  }

  addChange(result.staged, xy.charAt(0), path, from);
  addChange(result.unstaged, xy.charAt(1), path, from);
}

export function parseStatus({ stdout }: ParserInput): Status {
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

  const fields = nulFields(stdout, "git status");

  for (let index = 0; index < fields.length; index++) {
    const line = required(fields[index], "git status", stdout);

    if (line.startsWith("# ")) {
      statusHeader(result, line);
    } else if (line.startsWith("? ")) {
      result.untracked.push(required(line.slice(2), "git status", line));
    } else if (line.startsWith("! ")) {
      required(line.slice(2), "git status", line);
    } else {
      const from = line.startsWith("2 ")
        ? required(fields[++index], "git status", line)
        : undefined;

      statusRecord(result, line, from);
    }
  }

  return result;
}
