import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import hello from "../../../examples/hello.loopy.ts";
import review from "../../../examples/review.loopy.ts";
import assetSync from "../../../examples/uacode-asset-sync/asset-sync-pr.loopy.ts";
import type { Files } from "../../../examples/www-uacode-sync/json-edit.ts";
import {
  planSync,
  sourceFiles,
  syncCommitMessage,
  targetFiles,
} from "../../../examples/www-uacode-sync/sync.ts";
import { blobSha } from "../../../examples/www-uacode-sync/verify.ts";
import wwwSync from "../../../examples/www-uacode-sync/www-uacode-sync.loopy.ts";
import type { Executor, ResolvedCommand } from "../src/runtime/index.js";
import { MemoryRunStore } from "../src/runtime/index.js";
import type { Loopy } from "../src/sdk/index.js";
import { FakeExecutor, startLoopy } from "./fixture.js";
import { makeFixture, sourceFixture } from "./fixtures/examples.ts";

test("hello records a durable greeting and its log", async () => {
  const store = new MemoryRunStore();
  const executor = new FakeExecutor();
  expect(
    await startLoopy({
      loopy: hello,
      input: { name: "Hatim", enthusiastic: true },
      store,
      executor,
      runId: "hello",
      bundleHash: "fixture",
      workspace: "/workspace",
    }),
  ).toEqual({ status: "succeeded", output: { greeting: "Hello, Hatim!" } });
  expect(await store.getSteps("hello")).toMatchObject([
    { key: "greet", kind: "function", output: "Hello, Hatim!" },
  ]);
  expect(await store.getLogs("hello")).toMatchObject([{ message: "Hello, Hatim!" }]);
  expect(executor.calls).toEqual([]);
});

for (const changed of [false, true]) {
  test(`review ${changed ? "calls Codex with the diff" : "skips Codex for a clean checkout"}`, async () => {
    const store = new MemoryRunStore();
    const executor = reviewExecutor(changed);

    const options = {
      loopy: review,
      store,
      executor,
      runId: "review",
      bundleHash: "fixture",
      workspace: "/workspace",
    };

    expect(
      await startLoopy({ ...options, input: { instructions: "Check correctness." } }),
    ).toMatchObject({ status: "succeeded", output: { outcome: changed ? "reviewed" : "clean" } });
    expect(executor.calls.map((command) => command.program)).toEqual(
      changed ? ["git", "git", "codex"] : ["git"],
    );

    if (changed) {
      expect(executor.calls[2]).toMatchObject({
        args: ["exec", "--sandbox", "read-only", "--", "-"],
        stdin:
          "Review these changes without editing files.\ndiff --git a/src/app.ts b/src/app.ts\n+new code\nCheck correctness.",
      });
    }

    expect((await store.getSteps("review")).map((step) => step.key)).toEqual(
      changed ? ["git.diff", "git.diff", "codex.exec"] : ["git.diff"],
    );
    expect(await store.getLogs("review")).toHaveLength(1);
  });
}

// Command fixtures model the tools, while the definitions decide which effects to request.
class RecordingExecutor extends FakeExecutor {
  constructor(
    private output: (
      command: ResolvedCommand,
    ) => string | { stdout: string; stderr: string; exitCode: number },
  ) {
    super();
  }
  // BOUNDARY: Recording command fixtures can supply stdout alone or a full exit result.
  override async execute(command: ResolvedCommand, options: Parameters<Executor["execute"]>[1]) {
    this.calls.push(command);
    this.options.push(options);

    const output = this.output(command);

    return {
      ...(typeof output === "string" ? { stdout: output, stderr: "", exitCode: 0 } : output),
      durationMs: 1,
    };
  }
}

const baseSha = "a".repeat(40);

const sourceSha = "b".repeat(40);

const assetPath = "configs/platform-features/ai-agents/asset-repository/fixture.json";

const prUrl = "https://github.com/unify-apps/uacode/pull/123";

function gitOutput(command: ResolvedCommand) {
  const [name] = command.args;

  if (command.program === "stat") {
    return `${command.args.at(-1)}\x011\x011700000000\x01Directory\x01755\n`;
  }

  if (name === "remote") {
    return "origin\tgit@github.com:unify-apps/uacode.git (fetch)\norigin\tgit@github.com:unify-apps/uacode.git (push)\n";
  }

  if (name === "ls-remote") {
    return `${baseSha}\trefs/heads/main\n`;
  }

  if (name === "rev-parse") {
    return command.args.includes("--show-toplevel") ? `${command.cwd}\n` : `${baseSha}\n`;
  }

  return "";
}

function assetExecutor(dryRun: boolean, changed = true, fail = "") {
  let branch = "main";

  return new RecordingExecutor((command) => {
    if (command.args[0] === "worktree" && command.args[1] === "add") {
      branch = command.args[command.args.indexOf("-b") + 1] ?? "";
    }

    if (command.args[0] === "status") {
      return `# branch.oid ${baseSha}\0# branch.head ${branch}\0${!dryRun && changed ? `? ${assetPath}\0` : ""}`;
    }

    if (command.args[0] === fail) {
      throw new Error("Fixture publication failed.");
    }

    if (command.program === "git" && command.args.includes("--numstat")) {
      return !dryRun && changed ? `1\t0\t${assetPath}\0` : "";
    }

    if (command.program === "codex") {
      return JSON.stringify({
        proposedFiles: changed ? [assetPath] : [],
        checks: ["sync-preview"],
      });
    }

    if (command.program === "gh") {
      return prUrl;
    }

    return gitOutput(command);
  });
}

async function runAsset(
  executor: Executor,
  dryRun: boolean,
  { repository = "/fixture/uacode", exportDirectory = "/fixture/export" } = {},
) {
  const store = new MemoryRunStore();

  const result = await startLoopy({
    loopy: assetSync,
    input: {
      repository,
      dryRun,
      exportDirectory,
      assets: [{ assetClass: "WORKFLOW_DEFINITION", assetId: "fixture" }],
    },
    store,
    executor,
    runId: "asset",
    bundleHash: "fixture",
    workspace: "/unrelated cwd",
  });

  return { store, result };
}

for (const dryRun of [true, false]) {
  test(`asset sync records the ${dryRun ? "preview" : "publication"} sequence`, async () => {
    const executor = assetExecutor(dryRun);
    const { store, result } = await runAsset(executor, dryRun);
    expect(result).toMatchObject({
      status: "succeeded",
      output: {
        dryRun,
        prUrl: dryRun ? null : prUrl,
        proposedFiles: [assetPath],
        checks: ["sync-preview"],
      },
    });
    const steps = await store.getSteps("asset");
    expect(steps.map((step) => step.key)).toEqual(assetStepKeys(dryRun));
    expect(executor.calls.map(commandName)).toEqual(assetCommandNames(dryRun));
    const agent = executor.calls.find((command) => command.program === "codex");
    expect(agent?.stdin).toContain("Never create branches, commit, push");
    expect(agent?.args).toContain(
      dryRun ? "read-only" : "--dangerously-bypass-approvals-and-sandbox",
    );
    expect(executor.calls.every((command) => command.cwd !== "/unrelated cwd")).toBe(true);

    if (!dryRun) {
      assertAssetPublication(executor.calls);
    }
  });
}

function commandName(command: ResolvedCommand) {
  return [
    command.program,
    ...command.args.slice(0, command.args[0] === "worktree" || command.program === "gh" ? 2 : 1),
  ].join(" ");
}

const assetPreviewSteps = [
  "git.diff",
  "git.status",
  "codex.exec",
  "git.diff",
  "git.status",
  "git.rev-parse",
  "sh.exec",
];

const assetApplySteps = [
  "git.worktree.add",
  "codex.exec",
  "git.rev-parse",
  "sh.exec",
  "git.diff",
  "git.status",
  "git.add",
  "git.commit",
  "git.push",
  "sh.exec",
  "git.worktree.remove",
  "git.branch",
];

const assetPreviewCommands = [
  "git diff",
  "git status",
  "codex exec",
  "git diff",
  "git status",
  "git rev-parse",
  "git diff",
];

const assetApplyCommands = [
  "git worktree add",
  "codex exec",
  "git rev-parse",
  "git diff",
  "git diff",
  "git status",
  "git add",
  "git commit",
  "git push",
  "gh pr create",
  "git worktree remove",
  "git branch",
];

function assetStepKeys(dryRun: boolean) {
  return [
    "git.remote",
    "sh.exec",
    "sh.exec",
    "sh.exec",
    ...(dryRun ? [] : ["git.fetch"]),
    "git.rev-parse",
    "fs.stat",
    "sh.exec",
    "sh.exec",
    "fs.stat",
    "uuid",
    "now",
    ...(dryRun ? assetPreviewSteps : assetApplySteps),
  ];
}

function assetCommandNames(dryRun: boolean) {
  return [
    "git remote",
    "git check-ref-format",
    "git check-ref-format",
    "git ls-remote",
    ...(dryRun ? [] : ["git fetch"]),
    "git rev-parse",
    "stat -f",
    "git cat-file",
    "gh auth status",
    "stat -f",
    ...(dryRun ? assetPreviewCommands : assetApplyCommands),
  ].map((command) =>
    process.platform === "linux" ? command.replace("stat -f", "stat -c") : command,
  );
}

function assertAssetPublication(calls: ResolvedCommand[]) {
  const add = calls.find((command) => command.args[0] === "add");
  expect(add?.args).toEqual(["add", "--", assetPath]);

  const worktree = calls.find(
    (command) => command.args[0] === "worktree" && command.args[1] === "add",
  );

  expect(worktree?.args.at(-1)).toBe(baseSha);
  const pr = calls.find((command) => command.program === "gh" && command.args[1] === "create");
  expect(pr?.args.slice(0, 7)).toEqual([
    "pr",
    "create",
    "--repo",
    "unify-apps/uacode",
    "--base",
    "main",
    "--head",
  ]);
  expect(pr?.args.at(-1)).toContain(assetPath);
  expect(calls.at(-2)?.args.slice(0, 3)).toEqual(["worktree", "remove", "--force"]);
  expect(calls.at(-1)?.args.slice(0, 2)).toEqual(["branch", "--delete"]);
}

test("asset sync skips publication without changes and cleans up a failed attempt", async () => {
  const unchanged = assetExecutor(false, false);
  expect((await runAsset(unchanged, false)).result.status).toBe("succeeded");
  expect(unchanged.calls.some((command) => command.args[0] === "commit")).toBe(false);
  const failed = assetExecutor(false, true, "commit");
  const { result } = await runAsset(failed, false);
  expect(result.status).toBe("failed");
  expect(failed.calls.at(-2)?.args.slice(0, 2)).toEqual(["worktree", "remove"]);
});

function wwwExecutor(
  options: {
    changed?: boolean;
    existing?: boolean;
    branchWithoutPr?: boolean;
    equalTree?: boolean;
    failPush?: boolean;
    manualEdit?: boolean;
    compareMissing?: boolean;
  } = {},
) {
  const { content, files } = makeFixture();
  const source = sourceFixture(content);
  const changes = planSync(source, files, sourceSha);

  const desired = generatedFiles(source, files, sourceSha);
  const previous = generatedFiles(source, files, "d".repeat(40));

  const executor = new RecordingExecutor((command) => {
    if (command.program === "gh") {
      return githubOutput(command.args, {
        source,
        target: options.changed === false ? desired : files,
        existing: options.existing || options.branchWithoutPr ? previous : null,
        hasPr: options.existing ?? false,
        compareMissing: options.compareMissing ?? false,
        manualEdit: options.manualEdit ?? false,
      });
    }

    if (command.args[0] === "push" && options.failPush) {
      throw new Error("Concurrent push rejected.");
    }

    if (command.args.includes("--numstat")) {
      return changes.map(({ path }) => `1\t0\t${path}\0`).join("");
    }

    if (command.args[0] === "write-tree") {
      return options.equalTree ? "f".repeat(40) : "desired-tree";
    }

    return gitOutput(command);
  });

  return { executor, changes, source, target: files, desired };
}

type GithubFixture = {
  source: Files;
  target: Files;
  existing: Files | null;
  manualEdit: boolean;
  hasPr: boolean;
  compareMissing: boolean;
};

function githubOutput(args: string[], fixture: GithubFixture) {
  const { source, target, existing } = fixture;
  const endpoint = args.find((arg) => arg.startsWith("repos/")) ?? "";

  if (endpoint.includes("/git/ref/heads/")) {
    if (endpoint.includes("chore") && !existing) {
      return { stdout: "{}", stderr: "gh: Not Found (HTTP 404)", exitCode: 1 };
    }

    return endpoint.includes("/www/")
      ? sourceSha
      : endpoint.includes("chore")
        ? "c".repeat(40)
        : baseSha;
  }

  if (endpoint.includes("/contents/")) {
    const path = endpoint.split("/contents/")[1]?.split("?ref=")[0] ?? "";

    return endpoint.includes("/www/")
      ? (source[path] ?? "")
      : ((endpoint.endsWith("c".repeat(40)) ? existing?.[path] : target[path]) ?? "");
  }

  return githubMetadata(args, fixture);
}

function githubMetadata(args: string[], fixture: GithubFixture) {
  const { target, existing } = fixture;
  const endpoint = args.find((arg) => arg.startsWith("repos/")) ?? "";

  if (endpoint.includes("/git/commits/")) {
    return JSON.stringify({
      message: syncCommitMessage("d".repeat(40), baseSha),
      tree: { sha: "f".repeat(40) },
    });
  }

  if (endpoint.includes("/compare/")) {
    const files = Object.entries(existing ?? {})
      .filter(([path, contents]) => contents !== target[path])
      .map(([filename, contents]) => ({
        filename,
        sha: fixture.manualEdit ? "e".repeat(40) : blobSha(contents),
        status: "modified",
      }));

    return JSON.stringify({ files: fixture.compareMissing ? files.slice(1) : files });
  }

  if (args[1] === "list") {
    return JSON.stringify(
      fixture.hasPr
        ? [{ url: prUrl, headRefName: `chore/www-agent-assets-${sourceSha.slice(0, 8)}-main` }]
        : [],
    );
  }

  return prUrl;
}

async function runWww(executor: RecordingExecutor, dryRun: boolean) {
  const store = new MemoryRunStore();
  const root = await mkdtemp(join(tmpdir(), "loopy-www-recording-"));

  try {
    const result = await startLoopy({
      loopy: wwwSync,
      input: { repository: join(root, "repository"), dryRun, targetBranches: "main" },
      store,
      executor,
      runId: "www",
      bundleHash: "fixture",
      workspace: "/unrelated cwd",
    });

    const steps = await store.getSteps("www");

    const directory = executor.calls
      .find((command) => command.args[0] === "worktree" && command.args[1] === "add")
      ?.args.at(-2);

    const written = directory
      ? await Promise.all(
          steps
            .filter((step) => step.key.startsWith("write "))
            .map((step) => Bun.file(join(directory, step.key.slice(6))).text()),
        )
      : [];

    return { store, result, written };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

for (const dryRun of [true, false]) {
  test(`www sync records the ${dryRun ? "preview" : "publication"} sequence`, async () => {
    const { executor, changes } = wwwExecutor();
    const { store, result, written } = await runWww(executor, dryRun);
    expect(result).toMatchObject({
      status: "succeeded",
      output: { dryRun, results: [{ changed: changes.map(({ path }) => path) }] },
    });
    expect(
      (await store.getSteps("www")).map((step) =>
        step.key.startsWith("write ") ? "write" : step.key,
      ),
    ).toEqual(wwwStepKeys(dryRun, changes.length));
    expect(executor.calls.map(commandName)).toEqual(wwwCommandNames(dryRun));

    const reads = executor.calls.filter((command) =>
      command.args.includes("Accept: application/vnd.github.raw+json"),
    );

    expect(reads).toHaveLength(sourceFiles.length + targetFiles.length);
    expect(
      reads.every(
        (command) =>
          command.args.at(-1)?.endsWith(sourceSha) || command.args.at(-1)?.endsWith(baseSha),
      ),
    ).toBe(true);
    expect(written).toEqual(dryRun ? [] : changes.map(({ contents }) => contents));
  });
}

function wwwStepKeys(dryRun: boolean, count: number) {
  return [
    "git.rev-parse",
    "git.remote",
    "github.remote-sha",
    ...Array<string>(sourceFiles.length).fill("sh.exec"),
    "uuid",
    "github.remote-sha",
    ...Array<string>(targetFiles.length).fill("sh.exec"),
    "sh.exec",
    "github.remote-sha",
    ...(dryRun
      ? []
      : [
          "git.fetch",
          "git.worktree.add",
          ...Array<string>(count).fill("write"),
          "git.diff",
          "sh.exec",
          "git.add",
          "sh.exec",
          "git.commit",
          "git.push",
          "sh.exec",
          "git.worktree.remove",
        ]),
  ];
}

function wwwCommandNames(dryRun: boolean) {
  return [
    "git rev-parse",
    "git remote",
    "gh api repos/unify-apps/www/git/ref/heads/main",
    ...Array<string>(sourceFiles.length).fill("gh api -H"),
    "gh api repos/unify-apps/uacode/git/ref/heads/main",
    ...Array<string>(targetFiles.length).fill("gh api -H"),
    "gh pr list",
    `gh api repos/unify-apps/uacode/git/ref/heads/chore%2Fwww-agent-assets-${sourceSha.slice(0, 8)}-main`,
    ...(dryRun
      ? []
      : [
          "git fetch",
          "git worktree add",
          "git diff",
          "git diff",
          "git add",
          "git write-tree",
          "git commit",
          "git push",
          "gh pr create",
          "git worktree remove",
        ]),
  ];
}

test("www sync reuses a verified PR and publishes with a fast-forward push", async () => {
  const { executor } = wwwExecutor({ existing: true });
  const { result, store } = await runWww(executor, false);
  expect(result.status).toBe("succeeded");
  expect((await store.getSteps("www")).some((step) => step.key === "www-sync-tree")).toBe(false);
  expect(
    executor.calls.some((command) => command.args.some((arg) => arg.includes("/compare/"))),
  ).toBe(true);
  expect(executor.calls.find((command) => command.args[0] === "push")?.args).toEqual([
    "push",
    "origin",
    `HEAD:refs/heads/chore/www-agent-assets-${sourceSha.slice(0, 8)}-main`,
  ]);
  expect(executor.calls.find((command) => command.args[1] === "edit")?.args).toContain(prUrl);
  const failure = wwwExecutor({ failPush: true });
  expect((await runWww(failure.executor, false)).result.status).toBe("failed");
  expect(failure.executor.calls.at(-1)?.args.slice(0, 2)).toEqual(["worktree", "remove"]);
});

test("www sync skips worktrees and publication when the snapshot is unchanged", async () => {
  const { executor } = wwwExecutor({ changed: false });
  expect((await runWww(executor, false)).result).toMatchObject({
    status: "succeeded",
    output: { results: [{ changed: [] }] },
  });
  expect(
    executor.calls.some(
      (command) =>
        command.args[0] === "worktree" ||
        (command.program === "gh" && command.args[0] === "pr") ||
        command.args.some((arg) => arg.includes("/compare/") || arg.includes("chore%2F")),
    ),
  ).toBe(false);
});

for (const example of ["asset", "www"] as const) {
  test(`${example} saved bundle runs outside the Loopy checkout`, async () => {
    const root = await mkdtemp(join(tmpdir(), "loopy-example-bundle-"));

    try {
      const loopy = await bundleExample(example, root);
      const executor = example === "asset" ? assetExecutor(false) : wwwExecutor().executor;

      const input =
        example === "asset"
          ? {
              repository: "/fixture/uacode",
              dryRun: false,
              exportDirectory: "/fixture/export",
              assets: [{ assetClass: "WORKFLOW_DEFINITION", assetId: "fixture" }],
            }
          : { repository: join(root, "repository"), dryRun: false, targetBranches: "main" };

      const result = await startLoopy({
        loopy,
        input,
        executor,
        store: new MemoryRunStore(),
        runId: "bundled",
        bundleHash: "fixture",
        workspace: root,
      });

      expect(result.status).toBe("succeeded");
      expect(executor.calls.some((command) => command.program === "bun")).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

async function bundleExample(example: "asset" | "www", outdir: string): Promise<Loopy> {
  const entry =
    example === "asset"
      ? "uacode-asset-sync/asset-sync-pr.loopy.ts"
      : "www-uacode-sync/www-uacode-sync.loopy.ts";

  const result = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "../../../examples", entry)],
    outdir,
    target: "bun",
  });

  expect(result.success).toBe(true);
  const output = result.outputs[0];

  if (!output) {
    throw new Error("Example bundle is missing.");
  }

  const module: { default: Loopy } = await import(output.path);

  return module.default;
}

test("asset prerequisite failures stop before worktree creation or Codex", async () => {
  for (const failure of ["remote", "script"]) {
    const executor = new RecordingExecutor((command) => {
      if (failure === "remote" && command.args[0] === "remote") {
        return "origin\tgit@github.com:someone/other.git (fetch)\n";
      }

      if (failure === "script" && command.args[0] === "cat-file") {
        throw new Error("Selected base lacks the sync script. Merge uacode#40724 first.");
      }

      return gitOutput(command);
    });

    expect((await runAsset(executor, false)).result.status).toBe(
      failure === "script" ? "suspended" : "failed",
    );
    expect(
      executor.calls.some(
        (command) => command.program === "codex" || command.args[0] === "worktree",
      ),
    ).toBe(false);
  }
});

function reviewExecutor(changed: boolean) {
  const executor = new FakeExecutor();
  executor.execute = async (command, options) => {
    executor.calls.push(command);
    executor.options.push(options);

    return {
      ...executor.result,
      stdout: command.args.includes("--numstat")
        ? changed
          ? "2\t0\tsrc/app.ts\0"
          : ""
        : command.program === "git"
          ? "diff --git a/src/app.ts b/src/app.ts\n+new code"
          : "Found an issue.",
    };
  };

  return executor;
}

function generatedFiles(source: Files, target: Files, sha: string) {
  return {
    ...target,
    ...Object.fromEntries(
      planSync(source, target, sha).map(({ path, contents }) => [path, contents]),
    ),
  };
}

test("www sync rejects a generated branch whose exact tree was edited", async () => {
  const { executor } = wwwExecutor({ existing: true, manualEdit: true });
  const { result } = await runWww(executor, false);
  expect(result).toMatchObject({
    status: "failed",
    error: expect.stringContaining("manual tree edits"),
  });
  expect(
    executor.calls.some((command) => command.args[0] === "worktree" || command.args[0] === "push"),
  ).toBe(false);
});

function fixtureGit(cwd: string, args: string[], stdin?: string) {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    stdin: stdin === undefined ? undefined : Buffer.from(stdin),
  });

  if (result.exitCode !== 0) {
    throw new Error(`Fixture Git failed: ${result.stderr.toString()}`);
  }

  return result.stdout.toString();
}

test("www publish retains the observed head and current base before a normal push", async () => {
  const { executor } = wwwExecutor({ existing: true });
  expect((await runWww(executor, false)).result.status).toBe("succeeded");
  const commands = executor.calls.map((command) => command.args);
  expect(commands.find((args) => args[0] === "worktree" && args[1] === "add")?.at(-1)).toBe(
    "c".repeat(40),
  );
  const merge = commands.findIndex((args) => args[0] === "merge");
  expect(commands[merge]).toEqual(["merge", "--no-commit", "--no-ff", "-s", "ours", baseSha]);
  expect(commands[merge + 1]).toEqual(["read-tree", "--reset", "-u", baseSha]);
  expect(commands.findIndex((args) => args[0] === "commit")).toBeGreaterThan(merge + 1);
  expect(commands.find((args) => args[0] === "push")).not.toContain("--force");
});

test("asset sync preserves dirty source files and unregisters its disposable worktree", async () => {
  const root = await mkdtemp(join(tmpdir(), "loopy-asset-isolation-"));

  try {
    const repository = await assetGitFixture(root);
    const before = fixtureGit(repository, ["status", "--porcelain"]);

    const executor = new RecordingExecutor((command) => {
      if (command.program === "codex") {
        fixtureGit(
          command.cwd ?? repository,
          ["apply"],
          `diff --git a/${assetPath} b/${assetPath}\n--- a/${assetPath}\n+++ b/${assetPath}\n@@ -1 +1 @@\n-old\n+new\n`,
        );

        return JSON.stringify({
          proposedFiles: [assetPath],
          checks: ["sync-preview", "sync-check"],
        });
      }

      if (command.program === "git" && command.args[0] !== "remote") {
        return fixtureGit(command.cwd ?? repository, command.args);
      }

      return command.program === "gh" ? prUrl : gitOutput(command);
    });

    expect((await runAsset(executor, false, { repository })).result.status).toBe("succeeded");
    expect(fixtureGit(repository, ["status", "--porcelain"])).toBe(before);
    expect(await Bun.file(join(repository, "user.txt")).text()).toBe("keep this local edit\n");
    expect(
      fixtureGit(repository, ["worktree", "list", "--porcelain"]).match(/^worktree /gm),
    ).toHaveLength(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function assetGitFixture(root: string) {
  const repository = join(root, "repository");
  fixtureGit(root, ["init", "-b", "main", repository]);
  fixtureGit(repository, ["config", "user.name", "Fixture"]);
  fixtureGit(repository, ["config", "user.email", "fixture@example.invalid"]);
  await Bun.write(join(repository, assetPath), "old\n");
  await Bun.write(
    join(repository, "scripts/platform-feature-assets/sync-t2w-assets.mjs"),
    "// fixture\n",
  );
  await Bun.write(join(repository, "user.txt"), "committed\n");
  fixtureGit(repository, ["add", "."]);
  fixtureGit(repository, ["commit", "-m", "base"]);
  fixtureGit(repository, ["remote", "add", "origin", repository]);
  await Bun.write(join(repository, "user.txt"), "keep this local edit\n");

  return repository;
}

for (const violation of ["outside", "staged", "conflicted", "branch", "head", "preview"] as const) {
  test(`asset sync rejects ${violation} changes before publication`, async () => {
    let branch = "main";
    let synchronized = false;

    const executor = new RecordingExecutor((command) => {
      if (command.program === "codex") {
        synchronized = true;

        return JSON.stringify({ proposedFiles: [assetPath], checks: [] });
      }

      if (command.args[0] === "worktree" && command.args[1] === "add") {
        branch = command.args[command.args.indexOf("-b") + 1] ?? "";
      }

      if (command.args[0] === "status") {
        const name = synchronized && violation === "branch" ? "wrong-branch" : branch;

        const entry =
          violation === "staged"
            ? `1 M. N... 100644 100644 100644 ${baseSha} ${baseSha} ${assetPath}`
            : violation === "conflicted"
              ? `u UU N... 100644 100644 100644 100644 ${baseSha} ${baseSha} ${baseSha} ${assetPath}`
              : violation === "outside"
                ? "? outside.json"
                : violation === "preview" && synchronized
                  ? `? ${assetPath}`
                  : "";

        return `# branch.oid ${baseSha}\0# branch.head ${name}\0${entry ? `${entry}\0` : ""}`;
      }

      if (synchronized && violation === "head" && command.args[0] === "rev-parse") {
        return sourceSha;
      }

      return gitOutput(command);
    });

    const { result } = await runAsset(executor, violation === "preview");

    const message =
      violation === "head"
        ? "Sync changed HEAD"
        : violation === "preview"
          ? "Preview changed the source checkout"
          : violation === "outside"
            ? "outside the selected"
            : "Sync must keep its branch";

    expect(result).toMatchObject({ status: "failed", error: expect.stringContaining(message) });
    expect(
      executor.calls.some((command) => ["add", "commit", "push"].includes(command.args[0] ?? "")),
    ).toBe(false);
  });
}

test("www sync recovers a verified branch that exists without an open PR", async () => {
  const { executor } = wwwExecutor({ branchWithoutPr: true });
  expect((await runWww(executor, false)).result).toMatchObject({
    status: "succeeded",
    output: { results: [{ pullRequest: prUrl }] },
  });
  expect(
    executor.calls
      .find((command) => command.args[0] === "worktree" && command.args[1] === "add")
      ?.args.at(-1),
  ).toBe("c".repeat(40));
  expect(
    executor.calls.some((command) => command.args.some((arg) => arg.includes("/compare/"))),
  ).toBe(true);
  expect(executor.calls.some((command) => command.args[1] === "create")).toBe(true);
});

test("www equal tree skips commit and push while refreshing the PR", async () => {
  const { executor } = wwwExecutor({ existing: true, equalTree: true });
  expect((await runWww(executor, false)).result.status).toBe("succeeded");
  expect(executor.calls.some((command) => ["commit", "push"].includes(command.args[0] ?? ""))).toBe(
    false,
  );
  expect(executor.calls.some((command) => command.args[1] === "edit")).toBe(true);
});

test("www comparison rejects a missing planned path", async () => {
  const { executor } = wwwExecutor({ branchWithoutPr: true, compareMissing: true });
  expect((await runWww(executor, false)).result).toMatchObject({
    status: "failed",
    error: expect.stringContaining("manual tree edits"),
  });
});

test("asset webhook precheck stops before worktree creation without an inherited secret", async () => {
  const executor = new RecordingExecutor((command) =>
    command.program === "sh" ? { stdout: "", stderr: "", exitCode: 1 } : gitOutput(command),
  );

  const { result } = await runAsset(executor, false, { exportDirectory: "" });
  expect(result.status).toBe("suspended");
  expect(executor.calls.some((command) => command.args[0] === "worktree")).toBe(false);
  expect(executor.calls.at(-1)?.args).toEqual(["-c", 'test -n "$UA_ASSET_EXPORT_WEBHOOK_URL"']);
});

for (const bundled of [false, true]) {
  test(`www ${bundled ? "bundled" : "source"} ref lookup retries network failures`, async () => {
    const root = await mkdtemp(join(tmpdir(), "loopy-www-network-"));

    try {
      const definition = bundled ? await bundleExample("www", root) : wwwSync;

      const executor = new RecordingExecutor((command) =>
        command.program === "gh"
          ? { stdout: "", stderr: "error connecting to api.github.com", exitCode: 1 }
          : gitOutput(command),
      );

      const store = new MemoryRunStore();

      const result = await startLoopy({
        loopy: definition,
        input: { repository: root, dryRun: true },
        executor,
        store,
        runId: "network",
        bundleHash: "fixture",
        workspace: root,
      });

      expect(result.status).toBe("suspended");
      expect((await store.getSteps("network")).at(-1)).toMatchObject({
        key: "github.remote-sha",
        status: "retrying",
        attempt: 1,
        maxAttempts: 3,
      });
      expect(executor.options.at(-1)?.timeoutMs).toBe(120_000);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
