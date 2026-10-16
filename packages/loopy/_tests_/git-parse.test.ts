import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Executor,
  MemoryRunStore,
  type ResolvedCommand,
  SYSTEM_CLOCK,
} from "../src/runtime/index.js";
import { type CommandResult, git, loopy, sleep } from "../src/sdk/index.js";
import { activateLoopy, startLoopy } from "../src/sdk/run.js";
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
import { FakeExecutor } from "./engine-fixture.js";

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

test("parsed command output is stored and replayed without executing", async () => {
  const executor = new FakeExecutor();
  executor.result = result(await fixture("status", "darwin"));
  const store = new MemoryRunStore();

  let time = 0;
  const clock = { ...SYSTEM_CLOCK, now: () => time };

  const definition = loopy({
    name: "parsed",
    run: async () => {
      const status = await git.status({ flags: { untrackedFiles: "all" } });
      await sleep("1s");

      return status;
    },
  });

  const options = { loopy: definition, store, executor, runId: "parsed", cwd: "/workspace", clock };
  expect(await startLoopy({ ...options, input: {}, bundleHash: "" })).toMatchObject({
    status: "suspended",
  });
  const expected = parseStatus(executor.result);
  const [stored] = await store.getSteps("parsed");
  expect(stored).toHaveProperty("output", expected);
  expect(stored).toMatchObject({
    key: "git.status",
    kind: "command",
    output: expected,
  });
  expect(executor.calls[0]?.args).toEqual([
    "status",
    "--porcelain=v2",
    "--branch",
    "-z",
    "--untracked-files=all",
  ]);
  time += 1000;
  expect(await activateLoopy(options)).toMatchObject({ status: "succeeded", output: expected });
  expect(executor.calls).toHaveLength(1);
});

test("parser errors fail the command step before storing output", async () => {
  const executor = new FakeExecutor();
  const store = new MemoryRunStore();

  const definition = loopy({
    name: "invalid",
    run: () => git.status({}, { retry: { attempts: 1 } }),
  });

  expect(
    await startLoopy({
      loopy: definition,
      executor,
      store,
      cwd: "/workspace",
      runId: "invalid",
      input: {},
      bundleHash: "",
    }),
  ).toMatchObject({ status: "failed" });
  const [stored] = await store.getSteps("invalid");
  expect(stored).toMatchObject({
    key: "git.status",
    kind: "command",
    status: "failed",
    error: "Unexpected git status output line: ok. Report this with the git version.",
  });
  expect(stored).not.toHaveProperty("output");
});

function compileOnlyChecks() {
  // @ts-expect-error The parser owns its porcelain format.
  git.status({ flags: { porcelain: "v1" } });
  git.status.raw({ flags: { porcelain: "v1" } });
  const preset = { porcelain: "v1" } as const;
  // @ts-expect-error Preset keys also reject variables, not just excess object literals.
  git.status({ flags: preset });
  // @ts-expect-error All worktree list flags are owned by its parser.
  git.worktree.list({ flags: { z: true } });
  const status: Promise<{ branch: string | null }> = git.status();
  const raw: Promise<CommandResult> = git.status.raw();
  void status;
  void raw;
}

void compileOnlyChecks;

class SpawnExecutor implements Executor {
  async execute(command: ResolvedCommand, options: { cwd: string }): Promise<CommandResult> {
    const child = Bun.spawn([command.program, ...command.args], {
      cwd: command.cwd ?? options.cwd,
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);

    return { stdout, stderr, exitCode, durationMs: 0 };
  }
}

async function prepareRepo(cwd: string) {
  const executor = new SpawnExecutor();

  for (const args of [
    ["init", "-b", "main"],
    ["config", "user.name", "Smoke"],
    ["config", "user.email", "smoke@example.com"],
  ]) {
    expect((await executor.execute({ program: "git", args }, { cwd })).exitCode).toBe(0);
  }

  await writeFile(join(cwd, "file.txt"), "hello\n");

  for (const args of [
    ["add", "."],
    ["commit", "-m", "Smoke subject\n\nBody line\n\nLast line"],
  ]) {
    expect((await executor.execute({ program: "git", args }, { cwd })).exitCode).toBe(0);
  }

  return executor;
}

test("real git status, log and worktree.list run through the command step", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "loopy-git-smoke-"));

  try {
    const executor = await prepareRepo(cwd);
    await writeFile(join(cwd, "untracked.txt"), "untracked\n");
    const store = new MemoryRunStore();

    const definition = loopy({
      name: "smoke",
      run: async () => ({
        status: await git.status(),
        log: await git.log(),
        worktrees: await git.worktree.list(),
      }),
    });

    const completed = await startLoopy({
      loopy: definition,
      store,
      executor,
      cwd,
      runId: "smoke",
      input: {},
      bundleHash: "",
    });

    expect(completed).toMatchObject({
      status: "succeeded",
      output: {
        status: { branch: "main", untracked: ["untracked.txt"] },
        log: [{ subject: "Smoke subject", body: "Body line\n\nLast line\n" }],
        worktrees: [{ branch: "main", bare: false, locked: false }],
      },
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("raw calls omit presets and preserve the command result", async () => {
  const executor = new FakeExecutor();
  const store = new MemoryRunStore();

  const definition = loopy({
    name: "raw",
    run: () => git.status.raw({ flags: { porcelain: "v1" } }),
  });

  expect(
    await startLoopy({
      loopy: definition,
      executor,
      store,
      cwd: "/workspace",
      runId: "raw",
      input: {},
      bundleHash: "",
    }),
  ).toMatchObject({ status: "succeeded", output: executor.result });
  expect(executor.calls[0]?.args).toEqual(["status", "--porcelain=v1"]);
});
