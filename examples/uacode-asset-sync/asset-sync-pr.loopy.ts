import { fs, git, loopy, sh, step } from "loopy";
import { codexExec } from "../codex.ts";
import { changedFiles, pullRequestBody, syncPrompt } from "./prompt.ts";
import { parseRequest, type Request, script } from "./run.ts";

export default loopy({
  name: "uacode-asset-sync",
  description: "Sync requested uacode assets in a disposable worktree and open a focused PR.",
  mode: "full",
  input: {
    repository: "string",
    assetsJson: "string",
    dryRun: "boolean",
    "exportDirectory?": "string",
    "feature?": "string",
    "indexPath?": "string",
    "baseBranch?": "string",
    "branchPrefix?": "string",
    "prTitle?": "string",
  },
  run: async ({ input, log, uuid }) => {
    const request = await step("asset-request", () => {
      const { assetsJson, ...options } = input;

      const supplied = Object.fromEntries(
        Object.entries(options).filter(([, value]) => value !== undefined),
      );

      return parseRequest({ ...supplied, assets: JSON.parse(assetsJson) });
    });

    const base = await prerequisites(request);
    const id = await uuid();
    const branch = `${request.branchPrefix}-${id}`;
    const worktree = `${request.repository}-loopy-${id}`;

    if (request.dryRun) {
      log.info("Dry run: skip worktree creation, apply, staging, commit, push, PR and cleanup.");
      await preview(request, base);

      return { base, branch: null, files: [], dryRun: true, prUrl: null };
    }

    return apply(request, base, branch, worktree);
  },
});

async function prerequisites(request: Request) {
  const cwd = request.repository;
  const remotes = await git.remote(undefined, commandOptions(cwd));
  const origin = remotes.find((remote) => remote.name === "origin")?.fetch ?? "";

  if (
    !/^(?:git@github\.com:|https:\/\/github\.com\/|ssh:\/\/git@github\.com\/)unify-apps\/uacode(?:\.git)?$/.test(
      origin,
    )
  ) {
    throw new Error("Origin must be unify-apps/uacode on github.com.");
  }

  await sh.exec(["git", "check-ref-format", "--branch", request.baseBranch], commandOptions(cwd));
  await sh.exec(
    ["git", "check-ref-format", "--branch", `${request.branchPrefix}-check`],
    commandOptions(cwd),
  );

  const base = await selectedBase(request);

  await fs.stat({ args: [request.repository] }, commandOptions(cwd));
  await git.show({ revisions: [`${base}:${script}`] }, commandOptions(cwd));
  await sh.exec(["gh", "auth", "status"], commandOptions(cwd));

  if (request.exportDirectory) {
    await fs.stat({ args: [request.exportDirectory] }, commandOptions(cwd));
  }

  return base;
}

async function synchronize(request: Request, base: string, cwd: string) {
  const prompt = await step("asset-sync-prompt", () => syncPrompt(request, base));
  await codexExec(
    {
      args: ["-"],
      flags: {
        ...(request.dryRun
          ? { sandbox: "read-only" as const }
          : { dangerouslyBypassApprovalsAndSandbox: true }),
        ephemeral: true,
        cd: cwd,
      },
    },
    { cwd, stdin: prompt, timeout: "1h", retry: { attempts: 1 } },
  );
}

async function preview(request: Request, base: string) {
  const cwd = request.repository;

  if (!request.exportDirectory) {
    throw new Error("Supply an extracted exportDirectory for a read-only preview.");
  }

  const selected = await git.revParse({ args: ["HEAD"] }, commandOptions(cwd));

  if (selected !== base) {
    throw new Error(
      "Preview requires HEAD at the selected origin base. Use a checkout at that commit.",
    );
  }

  const before = (await git.diff.raw(undefined, commandOptions(cwd))).stdout;
  const status = await git.status(undefined, commandOptions(cwd));
  const head = await git.revParse({ args: ["HEAD"] }, commandOptions(cwd));
  await synchronize(request, base, cwd);
  const after = (await git.diff.raw(undefined, commandOptions(cwd))).stdout;
  const nextStatus = await git.status(undefined, commandOptions(cwd));
  const nextHead = await git.revParse({ args: ["HEAD"] }, commandOptions(cwd));

  if (
    before !== after ||
    JSON.stringify(status) !== JSON.stringify(nextStatus) ||
    JSON.stringify(head) !== JSON.stringify(nextHead)
  ) {
    throw new Error("Preview changed the source checkout. Inspect it before continuing.");
  }

  await git.diff(undefined, commandOptions(cwd));
  await sh.exec(["git", "diff", "--check"], commandOptions(cwd));
}

async function inspectChanges(
  request: Request,
  target: { cwd: string; base: string; branch: string },
) {
  const { cwd, base, branch } = target;
  const head = await git.revParse({ args: ["HEAD"] }, { cwd, retry: { attempts: 1 } });

  if (head !== base) {
    throw new Error("Sync changed HEAD. Leave all changes uncommitted for Loopy to publish.");
  }

  await sh.exec(["git", "diff", "--check"], commandOptions(cwd));
  const diff = await git.diff(undefined, commandOptions(cwd));
  const status = await git.status(undefined, commandOptions(cwd));

  if (status.staged.length || status.conflicts.length || status.branch !== branch) {
    throw new Error("Sync must keep its branch and leave changes unstaged and without conflicts.");
  }

  const files = changedFiles(
    [
      ...new Set([
        ...diff.flatMap((file) => (file.from ? [file.from, file.path] : [file.path])),
        ...status.untracked,
      ]),
    ],
    request,
  );

  return files;
}

async function publish(request: Request, cwd: string, branch: string, files: string[]) {
  const body = pullRequestBody(request, files);
  await git.add({ args: files }, commandOptions(cwd));
  await git.commit({ flags: { message: request.prTitle } }, commandOptions(cwd));
  await git.push({ args: ["origin", branch], flags: { setUpstream: true } }, commandOptions(cwd));

  const result = await sh.exec(
    [
      "gh",
      "pr",
      "create",
      "--repo",
      "unify-apps/uacode",
      "--base",
      request.baseBranch,
      "--head",
      branch,
      "--title",
      request.prTitle,
      "--body",
      body,
    ],
    commandOptions(cwd),
  );

  return result.stdout.trim();
}

function commandOptions(cwd: string) {
  return { cwd, retry: { attempts: 1 }, timeout: 45_000 };
}

async function selectedBase(request: Request) {
  const options = commandOptions(request.repository);

  const remote = await sh.exec(
    ["git", "ls-remote", "--exit-code", "origin", `refs/heads/${request.baseBranch}`],
    options,
  );

  const sha = remote.stdout.trim().split(/\s+/)[0] ?? "";

  if (!/^[a-f0-9]{40,64}$/.test(sha)) {
    throw new Error("Origin returned an invalid base SHA.");
  }

  if (!request.dryRun) {
    await git.fetch({ args: ["origin", sha] }, options);
  }

  return git.revParse({ args: [`${sha}^{commit}`], flags: { verify: true } }, options);
}

async function apply(request: Request, base: string, branch: string, worktree: string) {
  await git.worktree.add(
    { args: [worktree, base], flags: { b: branch } },
    commandOptions(request.repository),
  );

  try {
    await synchronize(request, base, worktree);
    const files = await inspectChanges(request, { cwd: worktree, base, branch });
    const prUrl = files.length ? await publish(request, worktree, branch, files) : null;

    return { base, branch, files, dryRun: false, prUrl };
  } finally {
    await git.worktree.remove(
      { args: [worktree], flags: { force: true } },
      commandOptions(request.repository),
    );
  }
}
