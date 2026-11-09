import type { ParserInput } from "@loopy/core";
import { nulFields, unexpected } from "../shared";
import { ISO_DATE, required, SHA } from "./shared";

type LogEntry = {
  sha: string;
  short: string;
  author: { name: string; email: string };
  date: string;
  subject: string;
  body: string;
};

type DiffEntry = {
  path: string;
  added: number | null;
  deleted: number | null;
  from?: string;
};

type DiffName = { path: string; status: string; from?: string };

// NUL cannot appear in a valid git commit message. Seven fields per record keep blank
// lines and even ASCII record-separator bytes in bodies intact; -z terminates each record.
export const LOG_FORMAT = "%H%x00%h%x00%an%x00%ae%x00%aI%x00%s%x00%b";

export function parseLog({ stdout }: ParserInput): LogEntry[] {
  const fields = nulFields(stdout, "git log");

  if (fields.length % 7 !== 0) {
    unexpected("git log", stdout);
  }

  const result: LogEntry[] = [];

  for (let index = 0; index < fields.length; index += 7) {
    const [sha = "", short = "", name = "", email = "", date = "", subject = "", body = ""] =
      fields.slice(index, index + 7);

    if (!SHA.test(sha) || !/^[a-f0-9]+$/.test(short) || !ISO_DATE.test(date)) {
      unexpected("git log", fields.slice(index, index + 7).join("\0"));
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

export function parseDiff({ stdout }: ParserInput): DiffEntry[] {
  const fields = nulFields(stdout, "git diff");
  const result: DiffEntry[] = [];

  for (let index = 0; index < fields.length; index++) {
    const line = required(fields[index], "git diff", stdout);
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(line);

    if (!match || (match[1] === "-") !== (match[2] === "-")) {
      unexpected("git diff", line);
    }

    const { entry, consumed } = diffPaths(fields, index, match[3] ?? "", "git diff");
    result.push({
      ...entry,
      added: match[1] === "-" ? null : Number(match[1]),
      deleted: match[2] === "-" ? null : Number(match[2]),
    });
    index += consumed;
  }

  return result;
}

export function parseDiffNames({ stdout }: ParserInput): DiffName[] {
  const fields = nulFields(stdout, "git diffNames");
  const result: DiffName[] = [];

  for (let index = 0; index < fields.length; index += 2) {
    const status = required(fields[index], "git diffNames", stdout);

    if (!/^(?:[ACDMRTUXB]|[RC]\d+|M\d+)$/.test(status)) {
      unexpected("git diffNames", status);
    }

    const path = required(fields[index + 1], "git diffNames", status);

    if (/^[RC]/.test(status)) {
      result.push({
        status,
        from: path,
        path: required(fields[index + 2], "git diffNames", status),
      });
      index++;
    } else {
      result.push({ status, path });
    }
  }

  return result;
}
