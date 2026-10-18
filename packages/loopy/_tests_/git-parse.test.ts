import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { type CommandResult } from "../src/sdk/index.js";
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

function result(stdout: string): CommandResult {
  return { stdout, stderr: "", exitCode: 0, durationMs: 1 };
}

function fixture(name: string, platform: string) {
  return readFile(new URL(`./fixtures/shell/git/${name}.${platform}.txt`, import.meta.url), "utf8");
}

for (const platform of ["darwin", "linux"]) {
  test(`status parses changes, conflicts and tracking (${platform})`, async () => {
    const parsed = parseStatus(result(await fixture("status", platform)));
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
    expect(parseStatus(result(await fixture("status-detached", platform)))).toEqual({
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

  test(`status retains literal newlines and tabs in paths (${platform})`, async () => {
    expect(parseStatus(result(await fixture("status-paths", platform))).staged).toEqual([
      { path: "line\nbreak.txt", status: "added" },
      { path: "tab\té.txt", status: "added" },
    ]);
  });

  test(`log preserves multiline bodies and separator bytes (${platform})`, async () => {
    const parsed = parseLog(result(await fixture("log", platform)));
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({
      author: { name: "Fixture Author", email: "fixture@example.com" },
      date: "2026-10-17T10:00:00+05:30",
      subject: "Main subject",
      body: "First body line\n\nSecond body line with RS \x1e inside.\n",
    });
    expect(parsed[0]?.sha).toBe((await fixture("rev-parse", platform)).trim());
    expect(parsed[0]?.short).toBe(parsed[0]?.sha.slice(0, 7));
    expect(parsed[1]?.subject).toBe("Initial commit");
    expect(parsed[1]?.body).toBe("");
  });

  test(`diff and diffNames retain renames and binary counts (${platform})`, async () => {
    expect(parseDiff(result(await fixture("diff", platform)))).toEqual([
      { path: "binary.bin", added: null, deleted: null },
      { path: "conflict.txt", added: 0, deleted: 0 },
      { path: "rename new.txt", from: "rename old.txt", added: 0, deleted: 0 },
      { path: "staged.txt", added: 1, deleted: 1 },
    ]);
    expect(parseDiffNames(result(await fixture("diff-names", platform)))).toEqual([
      { path: "binary.bin", status: "M" },
      { path: "conflict.txt", status: "U" },
      { path: "rename new.txt", from: "rename old.txt", status: "R100" },
      { path: "staged.txt", status: "M" },
    ]);
  });

  test(`branch and worktree records retain optional state (${platform})`, async () => {
    const branches = parseBranch(result(await fixture("branch", platform)));
    expect(
      branches.map(({ sha, ...branch }) => ({ ...branch, validSha: /^[a-f0-9]{40}$/.test(sha) })),
    ).toEqual([
      { name: "locked", current: false, upstream: null, ahead: 0, behind: 0, validSha: true },
      { name: "main", current: true, upstream: "origin/main", ahead: 1, behind: 1, validSha: true },
      { name: "other", current: false, upstream: null, ahead: 0, behind: 0, validSha: true },
    ]);
    const worktrees = parseWorktreeList(result(await fixture("worktree-list", platform)));
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
    expect(worktrees.every(({ path, sha }) => path.startsWith("/") && sha?.length === 40)).toBe(
      true,
    );
    expect(parseWorktreeList(result(await fixture("worktree-bare", platform)))).toEqual([
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

  test(`worktree lock reasons and prunable records (${platform})`, async () => {
    const entries = parseWorktreeList(result(await fixture("worktree-quoted", platform)));
    expect(entries.find(({ locked }) => locked)).toMatchObject({
      path: expect.stringContaining("/quoted\té"),
      lockReason: "Needs\nreview",
    });
    expect(entries.find(({ prunable }) => prunable)).toMatchObject({
      branch: "missing",
      prunable: "gitdir file points to non-existent location",
    });
  });

  test(`stash, tag, remote, revParse and lsFiles parse their captures (${platform})`, async () => {
    expect(parseStashList(result(await fixture("stash-list", platform)))).toEqual([
      {
        ref: "stash@{0}",
        sha: expect.stringMatching(/^[a-f0-9]{40}$/),
        message: "On main: Fixture stash",
      },
    ]);
    expect(parseTag(result(await fixture("tag", platform)))).toEqual([
      {
        name: "annotated",
        sha: expect.stringMatching(/^[a-f0-9]{40}$/),
        date: "2026-10-17T10:00:00+05:30",
      },
      { name: "lightweight", sha: (await fixture("rev-parse", platform)).trim(), date: null },
    ]);
    expect(parseRemote(result(await fixture("remote", platform)))).toEqual([
      {
        name: "origin",
        fetch: "https://example.com/fetch.git",
        push: "ssh://example.com/push.git",
      },
    ]);
    expect(parseRevParse(result(await fixture("rev-parse", platform)))).toMatch(/^[a-f0-9]{40}$/);
    expect(parseLsFiles(result(await fixture("ls-files", platform)))).toEqual([
      "binary.bin",
      "conflict.txt",
      "rename old.txt",
      "staged.txt",
      "unstaged.txt",
    ]);
  });
}

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
  expect(parseStatus(result(await fixture("status-stash", "linux"))).stashes).toBe(3);
  expect(parseStatus(result("")).stashes).toBe(0);
  expect(() => parseStatus(result("# stash invalid\0"))).toThrow(
    "Unexpected git status output line: # stash invalid. Report this with the git version.",
  );
});
