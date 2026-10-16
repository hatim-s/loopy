import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import hello from "../../../examples/hello.loopy.ts";
import review from "../../../examples/review.loopy.ts";
import assetSync from "../../../examples/uacode-asset-sync/asset-sync-pr.loopy.ts";
import { blobSha, hashTree, type TreeEntry } from "../../../examples/www-uacode-sync/git-tree.ts";
import type { Files } from "../../../examples/www-uacode-sync/json-edit.ts";
import {
  planSync,
  sourceFiles,
  syncCommitMessage,
  targetFiles,
} from "../../../examples/www-uacode-sync/sync.ts";
import wwwSync from "../../../examples/www-uacode-sync/www-uacode-sync.loopy.ts";
import type { Executor, ResolvedCommand } from "../src/runtime/index.js";
import { MemoryRunStore } from "../src/runtime/index.js";
import type { Loopy } from "../src/sdk/index.js";
import { makeFixture, sourceFixture } from "./examples-helpers.test.ts";
import { FakeExecutor, startLoopy } from "./fixture.js";

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
  constructor(private output: (command: ResolvedCommand) => string) {
    super();
  }
  override async execute(command: ResolvedCommand, options: Parameters<Executor["execute"]>[1]) {
    this.calls.push(command);
    this.options.push(options);

    return { stdout: this.output(command), stderr: "", exitCode: 0, durationMs: 1 };
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
    return command.args.includes("--show-toplevel") ? "/fixture/uacode\n" : `${baseSha}\n`;
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
      return `# branch.head ${branch}\0`;
    }

    if (command.args[0] === fail) {
      throw new Error("Fixture publication failed.");
    }

    if (command.program === "git" && command.args.includes("--numstat")) {
      return !dryRun && changed ? `1\t0\t${assetPath}\0` : "";
    }

    if (command.program === "gh") {
      return prUrl;
    }

    return gitOutput(command);
  });
}

async function runAsset(executor: Executor, dryRun: boolean, repository = "/fixture/uacode") {
  const store = new MemoryRunStore();

  const result = await startLoopy({
    loopy: assetSync,
    input: {
      repository,
      dryRun,
      exportDirectory: "/fixture/export",
      assetsJson: '[{"assetClass":"WORKFLOW_DEFINITION","assetId":"fixture"}]',
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
      output: { dryRun, prUrl: dryRun ? null : prUrl },
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
  "git.rev-parse",
  "git.diff",
  "git.status",
  "git.rev-parse",
  "asset-sync-prompt",
  "codex.exec",
  "git.diff",
  "git.status",
  "git.rev-parse",
  "git.diff",
  "sh.exec",
];

const assetApplySteps = [
  "git.worktree.add",
  "asset-sync-prompt",
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
];

const assetPreviewCommands = [
  "git rev-parse",
  "git diff",
  "git status",
  "git rev-parse",
  "codex exec",
  "git diff",
  "git status",
  "git rev-parse",
  "git diff",
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
];

function assetStepKeys(dryRun: boolean) {
  return [
    "asset-request",
    "git.remote",
    "sh.exec",
    "sh.exec",
    "sh.exec",
    ...(dryRun ? [] : ["git.fetch"]),
    "git.rev-parse",
    "fs.stat",
    "git.show",
    "sh.exec",
    "fs.stat",
    "uuid",
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
    "git show",
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
  expect(calls.at(-1)?.args.slice(0, 3)).toEqual(["worktree", "remove", "--force"]);
}

test("asset sync skips publication without changes and cleans up a failed attempt", async () => {
  const unchanged = assetExecutor(false, false);
  expect((await runAsset(unchanged, false)).result.status).toBe("succeeded");
  expect(unchanged.calls.some((command) => command.args[0] === "commit")).toBe(false);
  const failed = assetExecutor(false, true, "commit");
  const { result } = await runAsset(failed, false);
  expect(result.status).toBe("failed");
  expect(failed.calls.at(-1)?.args.slice(0, 2)).toEqual(["worktree", "remove"]);
});

function wwwExecutor(
  options: { changed?: boolean; existing?: boolean; failPush?: boolean; manualEdit?: boolean } = {},
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
        existing: options.existing ? previous : null,
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
      return "desired-tree";
    }

    return gitOutput(command);
  });

  return { executor, changes, source, target: files, desired };
}

type GithubFixture = { source: Files; target: Files; existing: Files | null; manualEdit: boolean };

function githubOutput(args: string[], fixture: GithubFixture) {
  const { source, target, existing } = fixture;
  const endpoint = args.find((arg) => arg.startsWith("repos/")) ?? "";

  if (endpoint.includes("/git/ref/heads/")) {
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
  const baseTree = treeFixture(target);
  const previousTree = existing ? treeFixture(existing) : null;
  const endpoint = args.find((arg) => arg.startsWith("repos/")) ?? "";

  if (endpoint.includes("/git/commits/")) {
    return JSON.stringify({
      message: syncCommitMessage(endpoint.endsWith(baseSha) ? sourceSha : "d".repeat(40), baseSha),
      tree: {
        sha: endpoint.endsWith(baseSha)
          ? baseTree.sha
          : fixture.manualEdit
            ? "e".repeat(40)
            : previousTree?.sha,
      },
    });
  }

  if (endpoint.includes("/git/trees/")) {
    const sha = endpoint.split("/").at(-1) ?? "";

    return baseTree.trees[sha] ?? "";
  }

  if (args[1] === "list") {
    return JSON.stringify(
      existing
        ? [{ url: prUrl, headRefName: `chore/www-agent-assets-${sourceSha.slice(0, 8)}-main` }]
        : [],
    );
  }

  return prUrl;
}

async function runWww(executor: Executor, dryRun: boolean) {
  const store = new MemoryRunStore();

  const result = await startLoopy({
    loopy: wwwSync,
    input: { repository: "/fixture/uacode", dryRun, targetBranches: "main" },
    store,
    executor,
    runId: "www",
    bundleHash: "fixture",
    workspace: "/unrelated cwd",
  });

  return { store, result };
}

for (const dryRun of [true, false]) {
  test(`www sync records the ${dryRun ? "preview" : "publication"} sequence`, async () => {
    const { executor, changes } = wwwExecutor();
    const { store, result } = await runWww(executor, dryRun);
    expect(result).toMatchObject({
      status: "succeeded",
      output: { dryRun, results: [{ changed: changes.map(({ path }) => path) }] },
    });
    expect((await store.getSteps("www")).map((step) => step.key)).toEqual(
      wwwStepKeys(dryRun, changes.length),
    );
    expect(executor.calls.map(commandName)).toEqual(wwwCommandNames(dryRun, changes.length));

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
    expect(
      executor.calls.filter((command) => command.program === "tee").map((command) => command.stdin),
    ).toEqual(dryRun ? [] : changes.map(({ contents }) => contents));
  });
}

function wwwStepKeys(dryRun: boolean, count: number) {
  return [
    "www-sync-options",
    "git.rev-parse",
    "fs.stat",
    "git.remote",
    "sh.exec",
    ...Array<string>(sourceFiles.length).fill("sh.exec"),
    "uuid",
    "sh.exec",
    ...Array<string>(targetFiles.length).fill("sh.exec"),
    "www-sync-plan",
    "sh.exec",
    "www-sync-pr",
    ...(dryRun
      ? []
      : [
          "git.fetch",
          "git.worktree.add",
          ...Array<string>(count).fill("sh.exec"),
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

function wwwCommandNames(dryRun: boolean, count: number) {
  return [
    "git rev-parse",
    process.platform === "linux" ? "stat -c" : "stat -f",
    "git remote",
    "gh api repos/unify-apps/www/git/ref/heads/main",
    ...Array<string>(sourceFiles.length).fill("gh api -H"),
    "gh api repos/unify-apps/uacode/git/ref/heads/main",
    ...Array<string>(targetFiles.length).fill("gh api -H"),
    "gh pr list",
    ...(dryRun
      ? []
      : [
          "git fetch",
          "git worktree add",
          ...Array<string>(count).fill("tee --"),
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
  expect((await store.getSteps("www")).some((step) => step.key === "www-sync-tree")).toBe(true);
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
  expect(executor.calls.some((command) => command.args[0] === "worktree")).toBe(false);
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
              assetsJson: '[{"assetClass":"WORKFLOW_DEFINITION","assetId":"fixture"}]',
            }
          : { repository: "/fixture/uacode", dryRun: false, targetBranches: "main" };

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

      if (failure === "script" && command.args[0] === "show") {
        throw new Error("Selected base lacks the sync script. Merge uacode#40724 first.");
      }

      return gitOutput(command);
    });

    expect((await runAsset(executor, false)).result.status).toBe("failed");
    expect(
      executor.calls.some(
        (command) => command.program === "codex" || command.args[0] === "worktree",
      ),
    ).toBe(false);
  }
});

function treeFixture(files: Files) {
  const trees: Record<string, string> = {};

  const build = (prefix: string): string => {
    const children = new Set(
      Object.keys(files)
        .filter((path) => path.startsWith(prefix))
        .map((path) => path.slice(prefix.length).split("/")[0] ?? ""),
    );

    const entries: TreeEntry[] = [...children].map((path) => {
      const contents = files[`${prefix}${path}`];

      return contents === undefined
        ? { path, mode: "040000", type: "tree", sha: build(`${prefix}${path}/`) }
        : { path, mode: "100644", type: "blob", sha: blobSha(contents) };
    });

    const sha = hashTree(entries);
    trees[sha] = JSON.stringify({ tree: entries, truncated: false });

    return sha;
  };

  return { sha: build(""), trees };
}

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

test("tree reconstruction matches Git object hashing and retains file modes", async () => {
  const root = await mkdtemp(join(tmpdir(), "loopy-example-tree-"));

  try {
    fixtureGit(root, ["init", "-q"]);
    const blob = fixtureGit(root, ["hash-object", "-w", "--stdin"], "fixture\n").trim();
    expect(blobSha("fixture\n")).toBe(blob);
    const leaf = { path: "entry", mode: "100644", type: "blob", sha: blob };
    const subtree = fixtureGit(root, ["mktree"], `100644 blob ${blob}\tentry\n`).trim();
    expect(hashTree([leaf])).toBe(subtree);

    const entries = [
      { path: "a", mode: "040000", type: "tree", sha: subtree },
      { path: "a.c", mode: "100755", type: "blob", sha: blob },
    ];

    const canonical = fixtureGit(
      root,
      ["mktree"],
      `040000 tree ${subtree}\ta\n100755 blob ${blob}\ta.c\n`,
    ).trim();

    expect(hashTree(entries)).toBe(canonical);
    expect(hashTree([leaf])).not.toBe(hashTree([{ ...leaf, mode: "100755" }]));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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

test("updating a generated tree retains the observed head and current base as parents", async () => {
  const root = await mkdtemp(join(tmpdir(), "loopy-example-parents-"));

  try {
    const { repository, observed, base } = await publicationFixture(root);
    const worktree = join(root, "worktree");
    fixtureGit(repository, ["worktree", "add", "--detach", worktree, observed]);
    fixtureGit(worktree, ["merge", "--no-commit", "--no-ff", "-s", "ours", base]);
    fixtureGit(worktree, ["read-tree", "--reset", "-u", base]);
    await Bun.write(join(worktree, "asset.json"), "new generated content");
    fixtureGit(worktree, ["add", "asset.json"]);
    fixtureGit(worktree, ["commit", "-m", "sync update"]);
    expect(fixtureGit(worktree, ["show", "-s", "--format=%P", "HEAD"]).trim().split(" ")).toEqual([
      observed,
      base,
    ]);
    expect(fixtureGit(worktree, ["show", "HEAD:base-update.txt"])).toBe("preserve current base\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function publicationFixture(root: string) {
  const repository = join(root, "repository");
  fixtureGit(root, ["init", "-b", "main", repository]);
  fixtureGit(repository, ["config", "user.name", "Fixture"]);
  fixtureGit(repository, ["config", "user.email", "fixture@example.invalid"]);
  await Bun.write(join(repository, "asset.json"), "base content");
  fixtureGit(repository, ["add", "."]);
  fixtureGit(repository, ["commit", "-m", "base"]);
  fixtureGit(repository, ["checkout", "-b", "generated"]);
  await Bun.write(join(repository, "asset.json"), "prior generated content");
  fixtureGit(repository, ["commit", "-am", "generated"]);
  const observed = fixtureGit(repository, ["rev-parse", "HEAD"]).trim();
  fixtureGit(repository, ["checkout", "main"]);
  await Bun.write(join(repository, "base-update.txt"), "preserve current base\n");
  fixtureGit(repository, ["add", "."]);
  fixtureGit(repository, ["commit", "-m", "advance base"]);

  return { repository, observed, base: fixtureGit(repository, ["rev-parse", "HEAD"]).trim() };
}

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

        return "";
      }

      if (command.program === "git" && command.args[0] !== "remote") {
        return fixtureGit(command.cwd ?? repository, command.args);
      }

      return command.program === "gh" ? prUrl : gitOutput(command);
    });

    expect((await runAsset(executor, false, repository)).result.status).toBe("succeeded");
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
