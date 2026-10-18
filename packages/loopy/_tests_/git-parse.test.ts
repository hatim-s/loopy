import { expect, test } from "bun:test";
import {
  parseBranch,
  parseDiff,
  parseDiffNames,
  parseLog,
  parseLsFiles,
  parseRemote,
  parseRevParse,
  parseStashList,
  parseStatus,
  parseTag,
  parseWorktreeList,
} from "../src/sdk/shell/parse/git.js";

import { fixture, result } from "./shell-parse-fixture.js";

test(`status parses changes, conflicts and tracking`, async () => {
  const parsed = parseStatus(result(await fixture("git", "status")));
  expect(parsed).toEqual({
    branch: "main",
    upstream: "origin/main",
    ahead: 1,
    behind: 1,
    stashes: 0,
    staged: [
      { path: "binary.bin", status: "modified" },
      { path: "rename new.txt", status: "renamed", from: "rename old.txt" },
      { path: "staged.txt", status: "modified" },
    ],
    unstaged: [{ path: "unstaged.txt", status: "modified" }],
    untracked: ["untracked.txt"],
    conflicts: [{ path: "conflict.txt", status: "UU" }],
  });
  expect(parseStatus(result(await fixture("git", "status-detached")))).toEqual({
    branch: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    stashes: 0,
    staged: [],
    unstaged: [],
    untracked: [],
    conflicts: [],
  });
});

test(`status retains literal newlines and tabs in paths`, async () => {
  expect(parseStatus(result(await fixture("git", "status-paths"))).staged).toEqual([
    { path: "line\nbreak.txt", status: "added" },
    { path: "tab\té.txt", status: "added" },
  ]);
});

test(`log preserves multiline bodies and separator bytes`, async () => {
  const parsed = parseLog(result(await fixture("git", "log")));
  expect(parsed).toHaveLength(2);
  expect(parsed[0]).toMatchObject({
    author: { name: "Fixture Author", email: "fixture@example.com" },
    date: "2026-10-17T10:00:00+05:30",
    subject: "Main subject",
    body: "First body line\n\nSecond body line with RS \x1e inside.\n",
  });
  expect(parsed[0]?.sha).toBe((await fixture("git", "rev-parse")).trim());
  expect(parsed[0]?.short).toBe(parsed[0]?.sha.slice(0, 7));
  expect(parsed[1]?.subject).toBe("Initial commit");
  expect(parsed[1]?.body).toBe("");
});

test(`diff and diffNames retain renames and binary counts`, async () => {
  expect(parseDiff(result(await fixture("git", "diff")))).toEqual([
    { path: "binary.bin", added: null, deleted: null },
    { path: "conflict.txt", added: 0, deleted: 0 },
    { path: "rename new.txt", from: "rename old.txt", added: 0, deleted: 0 },
    { path: "staged.txt", added: 1, deleted: 1 },
  ]);
  expect(parseDiffNames(result(await fixture("git", "diff-names")))).toEqual([
    { path: "binary.bin", status: "M" },
    { path: "conflict.txt", status: "U" },
    { path: "rename new.txt", from: "rename old.txt", status: "R100" },
    { path: "staged.txt", status: "M" },
  ]);
});

test(`branch and worktree records retain optional state`, async () => {
  const branches = parseBranch(result(await fixture("git", "branch")));
  expect(
    branches.map(({ sha, ...branch }) => ({ ...branch, validSha: /^[a-f0-9]{40}$/.test(sha) })),
  ).toEqual([
    { name: "locked", current: false, upstream: null, ahead: 0, behind: 0, validSha: true },
    { name: "main", current: true, upstream: "origin/main", ahead: 1, behind: 1, validSha: true },
    { name: "other", current: false, upstream: null, ahead: 0, behind: 0, validSha: true },
  ]);
  const worktrees = parseWorktreeList(result(await fixture("git", "worktree-list")));
  expect(worktrees).toHaveLength(3);
  expect(worktrees[0]).toMatchObject({
    branch: "main",
    bare: false,
    detached: false,
    locked: false,
  });
  expect(worktrees.find(({ locked }) => locked)).toMatchObject({
    branch: "locked",
    lockReason: "Fixture lock reason",
  });
  expect(worktrees.find(({ detached }) => detached)).toMatchObject({
    branch: null,
    detached: true,
  });
  expect(worktrees.every(({ path, sha }) => path.startsWith("/") && sha?.length === 40)).toBe(true);
  expect(parseWorktreeList(result(await fixture("git", "worktree-bare")))).toEqual([
    {
      path: expect.stringContaining("/bare.git"),
      sha: null,
      branch: null,
      bare: true,
      detached: false,
      locked: false,
    },
  ]);
});

test(`worktree lock reasons and prunable records`, async () => {
  const entries = parseWorktreeList(result(await fixture("git", "worktree-quoted")));
  expect(entries.find(({ locked }) => locked)).toMatchObject({
    path: expect.stringContaining("/quoted\té"),
    lockReason: "Needs\nreview",
  });
  expect(entries.find(({ prunable }) => prunable)).toMatchObject({
    branch: "missing",
    prunable: "gitdir file points to non-existent location",
  });
});

test(`stash, tag, remote, revParse and lsFiles parse their captures`, async () => {
  expect(parseStashList(result(await fixture("git", "stash-list")))).toEqual([
    {
      ref: "stash@{0}",
      sha: expect.stringMatching(/^[a-f0-9]{40}$/),
      message: "On main: Fixture stash",
    },
  ]);
  expect(parseTag(result(await fixture("git", "tag")))).toEqual([
    {
      name: "annotated",
      sha: expect.stringMatching(/^[a-f0-9]{40}$/),
      date: "2026-10-17T10:00:00+05:30",
    },
    { name: "lightweight", sha: (await fixture("git", "rev-parse")).trim(), date: null },
  ]);
  expect(parseRemote(result(await fixture("git", "remote")))).toEqual([
    {
      name: "origin",
      fetch: "https://example.com/fetch.git",
      push: "ssh://example.com/push.git",
    },
  ]);
  expect(parseRevParse(result(await fixture("git", "rev-parse")))).toMatch(/^[a-f0-9]{40}$/);
  expect(parseLsFiles(result(await fixture("git", "ls-files")))).toEqual([
    "binary.bin",
    "conflict.txt",
    "rename old.txt",
    "staged.txt",
    "unstaged.txt",
  ]);
});

test.each([
  ["status", parseStatus],
  ["log", parseLog],
  ["diff", parseDiff],
  ["diffNames", parseDiffNames],
  ["branch", parseBranch],
  ["worktree.list", parseWorktreeList],
  ["stash.list", parseStashList],
  ["tag", parseTag],
  ["remote", parseRemote],
  ["ls-files", parseLsFiles],
] as const)("%s rejects malformed machine output", (cmd, parse) => {
  expect(() => parse(result("invalid"))).toThrow(
    `Unexpected git ${cmd} output line: invalid. Report this with the git version.`,
  );
});

test("revParse rejects multiple values", () => {
  expect(() => parseRevParse(result("one\ntwo\n"))).toThrow(
    "Unexpected git rev-parse output line: one\ntwo\n. Report this with the git version.",
  );
});

test("status accepts the porcelain v2 stash header", async () => {
  expect(parseStatus(result(await fixture("git", "status-stash", "linux"))).stashes).toBe(3);
  expect(parseStatus(result("")).stashes).toBe(0);
  expect(() => parseStatus(result("# stash invalid\0"))).toThrow(
    "Unexpected git status output line: # stash invalid. Report this with the git version.",
  );
});
