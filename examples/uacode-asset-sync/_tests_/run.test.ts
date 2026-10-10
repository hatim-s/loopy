import { expect, test } from "bun:test";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Execute, parseRequest, run } from "../run.ts";

const base = "a".repeat(40);

const input = {
  repository: "/fixture/uacode",
  assets: [{ assetClass: "WORKFLOW_DEFINITION", assetId: "fixture" }],
  exportDirectory: "/fixture/export",
};

function fixture(options: { missingScript?: boolean; dirty?: boolean; movedHead?: boolean } = {}) {
  const calls: { args: string[]; cwd: string; stdin?: string }[] = [];

  const exec: Execute = async (args, cwd, stdin) => {
    calls.push({ args, cwd, stdin });

    if (args[0] === "codex") {
      const summaryPath = args[args.indexOf("--output-last-message") + 1];

      if (summaryPath) {
        await Bun.write(
          summaryPath,
          JSON.stringify({
            proposedFiles: ["configs/platform-features/ai-agents/asset-repository/fixture.json"],
            checks: ["sync-preview"],
          }),
        );
      }
    }

    if (args[1] === "remote") {
      return "git@github.com:unify-apps/uacode.git\n";
    }

    if (args[1] === "rev-parse" && args[2] === "--abbrev-ref") {
      return "HEAD";
    }

    if (args[1] === "rev-parse") {
      return options.movedHead && args[2] === "HEAD" ? "b".repeat(40) : base;
    }

    if (args[1] === "cat-file" && options.missingScript) {
      throw new Error("missing");
    }

    if (args[1] === "status") {
      return options.dirty ? " M forbidden.txt\n" : "";
    }

    return "";
  };

  return { exec, calls };
}

test("defaults and input validation happen before execution", () => {
  const request = parseRequest(input);
  expect(request.feature).toBe("ai-agents");
  expect(request.baseBranch).toBe("main");
  expect(request.dryRun).toBe(false);
  expect(request.prTitle).toBe("Sync exported T2W assets");

  for (const invalid of [
    { assets: [] },
    { assets: [{ assetClass: "", assetId: "a" }] },
    { dryRun: "false" },
    { indexPath: "../escape.json" },
    { feature: "../escape" },
    { typo: true },
  ]) {
    expect(() => parseRequest({ ...input, ...invalid })).toThrow();
  }
});

test("missing prerequisite fails before worktree creation or Codex", async () => {
  const f = fixture({ missingScript: true });
  await expect(run(parseRequest(input), f.exec)).rejects.toThrow("#40724");
  expect(f.calls.some(({ args }) => args[1] === "worktree" || args[0] === "codex")).toBe(false);
  expect(f.calls.some(({ args }) => args.join(" ") === "git fetch origin refs/heads/main")).toBe(
    true,
  );
  expect(
    f.calls.some(
      ({ args }) => args[3] === `${base}:scripts/platform-feature-assets/sync-t2w-assets.mjs`,
    ),
  ).toBe(true);
});

test("dry run uses an isolated exact-base worktree and prompt stdin, then removes it", async () => {
  const f = fixture();
  const result = await run(parseRequest({ ...input, dryRun: true }), f.exec);
  const agent = f.calls.find(({ args }) => args[0] === "codex");
  expect(agent).toBeDefined();
  expect(agent?.cwd).not.toBe(input.repository);
  expect(agent?.args.at(-1)).toBe("-");
  expect(agent?.stdin).toContain('"dryRun":true');
  expect(agent?.stdin).toContain("exact prTitle");
  expect(agent?.stdin).toContain("Never merge, approve, or close");
  expect(f.calls.find(({ args }) => args[1] === "worktree" && args[2] === "add")?.args.at(-1)).toBe(
    base,
  );
  expect(f.calls.find(({ args }) => args[1] === "status")?.cwd).toBe(agent?.cwd);
  expect(f.calls.at(-1)?.args.slice(0, 4)).toEqual(["git", "worktree", "remove", "--force"]);
  expect(result.files).toEqual([]);
  expect(result.proposedFiles).toEqual([
    "configs/platform-features/ai-agents/asset-repository/fixture.json",
  ]);
  expect(result.agentChecks).toEqual(["sync-preview"]);
  expect(result.prUrl).toBeUndefined();
  await expect(access(agent?.cwd ?? "")).rejects.toThrow();
});

test("dry-run violations fail and retain the worktree for inspection", async () => {
  for (const options of [{ dirty: true }, { movedHead: true }]) {
    const f = fixture(options);
    await expect(run(parseRequest({ ...input, dryRun: true }), f.exec)).rejects.toThrow();
    expect(f.calls.some(({ args }) => args[1] === "worktree" && args[2] === "remove")).toBe(false);
    const worktree = f.calls.find(({ args }) => args[0] === "codex")?.cwd;

    if (worktree) {
      await rm(worktree.replace(/\/worktree$/, ""), { recursive: true, force: true });
    }

    expect(f.calls.some(({ args }) => args[0] === "gh")).toBe(false);
  }
});

test("unexpected remote fails before fetch", async () => {
  const calls: string[][] = [];

  const exec: Execute = async (args) => {
    calls.push(args);

    return "git@github.com:someone/other.git";
  };

  await expect(run(parseRequest(input), exec)).rejects.toThrow("origin must");
  expect(calls).toHaveLength(1);
});

test("real local Git isolates a dirty checkout and unregisters the successful worktree", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "asset-sync-fixture-"));
  const repository = join(temporary, "source");
  await mkdir(repository);

  const git = (args: string[], cwd = repository) => {
    const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });

    if (result.exitCode !== 0) {
      throw new Error(`Fixture git failed: ${args[0]}`);
    }

    return result.stdout.toString();
  };

  try {
    git(["init", "-b", "main"]);
    git(["config", "user.email", "fixture@example.invalid"]);
    git(["config", "user.name", "Fixture"]);
    await mkdir(join(repository, "scripts/platform-feature-assets"), { recursive: true });
    await Bun.write(
      join(repository, "scripts/platform-feature-assets/sync-t2w-assets.mjs"),
      "// fixture\n",
    );
    await Bun.write(join(repository, "local.txt"), "original\n");
    git(["add", "."]);
    git(["commit", "-m", "fixture base"]);
    git(["remote", "add", "origin", repository]);
    await Bun.write(join(repository, "local.txt"), "keep this local change\n");
    const before = git(["status", "--porcelain"]);
    let isolated = "";

    const exec: Execute = async (args, cwd) => {
      if (args[0] === "git" && args[1] === "remote") {
        return "git@github.com:unify-apps/uacode.git";
      }

      if (args[0] === "codex") {
        isolated = cwd;
        expect(await Bun.file(join(cwd, "local.txt")).text()).toBe("original\n");
        expect(git(["status", "--porcelain"], cwd)).toBe("");
        const summaryPath = args[args.indexOf("--output-last-message") + 1];

        if (summaryPath) {
          await Bun.write(summaryPath, '{"proposedFiles":[],"checks":["sync-preview"]}');
        }

        return "";
      }

      return git(args.slice(1), cwd);
    };

    await run(parseRequest({ ...input, repository, dryRun: true }), exec);
    expect(git(["status", "--porcelain"])).toBe(before);
    expect(await Bun.file(join(repository, "local.txt")).text()).toBe("keep this local change\n");
    expect(git(["worktree", "list", "--porcelain"])).not.toContain(isolated);
    await expect(access(isolated)).rejects.toThrow();
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
