import { fs, git, loopy, sh } from "loopy";
import { codexExec } from "../codex.ts";
import { readOptions, writeOptions } from "../options.ts";
import { changedFiles, parseSummary, pullRequestBody, syncPrompt } from "./prompt.ts";
import { type Request, requestSchema, script } from "./request.ts";

export default loopy({
  name: "uacode-asset-sync",
  description: "Sync requested uacode assets in a disposable worktree and open a focused PR.",
  mode: "full",
  input: requestSchema,
  run: async ({ input: request, log, uuid, now }) => {
    const base = await prerequisites(request);
    const id = await uuid();
    const date = new Date(await now()).toISOString().slice(0, 10).replaceAll("-", "");
    const branch = `${request.branchPrefix}-${date}-${id.slice(0, 8)}`;
    const worktree = `${request.repository}-loopy-${id}`;

    if (request.dryRun) {
      log.info("Dry run: skip worktree creation, apply, staging, commit, push, PR and cleanup.");
      const summary = await preview(request, base);

      return { base, branch: null, files: [], dryRun: true, prUrl: null, ...summary };
    }

    return apply(request, base, branch, worktree);
  },
});

async function prerequisites(request: Request) {
  const cwd = request.repository;
  const options = { ...readOptions, cwd };
  const remotes = await git.remote(undefined, options);
  const origin = remotes.find((remote) => remote.name === "origin")?.fetch ?? "";

  if (
    !/^(?:git@github\.com:|https:\/\/github\.com\/|ssh:\/\/git@github\.com\/)unify-apps\/uacode(?:\.git)?$/.test(
      origin,
    )
  ) {
    throw new Error("Origin must be unify-apps/uacode on github.com. Use the correct checkout.");
  }

  await sh.exec(["git", "check-ref-format", "--branch", request.base], options);
  await sh.exec(["git", "check-ref-format", "--branch", `${request.branchPrefix}-check`], options);
  const base = await selectedBase(request);
  await fs.stat({ args: [cwd] }, options);

  try {
    await sh.exec(["git", "cat-file", "-e", `${base}:${script}`], options);
  } catch {
    throw new Error(
      "The selected base lacks the sync script. Merge unify-apps/uacode#40724 first.",
    );
  }

  await sh.exec(["gh", "auth", "status"], options);

  if (request.exportDirectory) {
    await fs.stat({ args: [request.exportDirectory] }, options);
  } else {
    await webhookPrecheck(cwd);
  }

  return base;
}

async function webhookPrecheck(cwd: string) {
  try {
    await sh.exec(["sh", "-c", 'test -n "$UA_ASSET_EXPORT_WEBHOOK_URL"'], { ...readOptions, cwd });
  } catch {
    throw new Error(
      "Missing UA_ASSET_EXPORT_WEBHOOK_URL. Set it in the inherited environment or supply exportDirectory.",
    );
  }
}

function synchronize(request: Request, base: string, cwd: string) {
  return codexExec(
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
    { ...writeOptions, cwd, stdin: syncPrompt(request, base), timeout: "1h" },
  );
}

async function preview(request: Request, base: string) {
  const cwd = request.repository;
  const options = { ...readOptions, cwd };
  const before = (await git.diff.raw(undefined, options)).stdout;
  const status = await git.status({ flags: { untrackedFiles: "all" } }, options);
  const result = await synchronize(request, base, cwd);
  const after = (await git.diff.raw(undefined, options)).stdout;
  const nextStatus = await git.status({ flags: { untrackedFiles: "all" } }, options);
  const nextHead = await git.revParse({ args: ["HEAD"] }, options);

  if (
    before !== after ||
    JSON.stringify(status) !== JSON.stringify(nextStatus) ||
    nextHead !== base
  ) {
    throw new Error("Preview changed the source checkout. Inspect it before continuing.");
  }

  await sh.exec(["git", "diff", "--check"], options);

  return parseSummary(result.stdout, request);
}

async function inspectChanges(
  request: Request,
  target: { cwd: string; base: string; branch: string },
) {
  const { cwd, base, branch } = target;
  const options = { ...readOptions, cwd };
  const head = await git.revParse({ args: ["HEAD"] }, options);

  if (head !== base) {
    throw new Error("Sync changed HEAD. Leave all changes uncommitted for Loopy to publish.");
  }

  await sh.exec(["git", "diff", "--check"], options);
  const diff = await git.diff(undefined, options);
  const status = await git.status({ flags: { untrackedFiles: "all" } }, options);

  if (status.staged.length || status.conflicts.length || status.branch !== branch) {
    throw new Error(
      "Sync must keep its branch and leave changes unstaged and without conflicts. Restore the generated branch and unstage or resolve changes before retrying.",
    );
  }

  return changedFiles(
    [
      ...new Set([
        ...diff.flatMap((file) => (file.from ? [file.from, file.path] : [file.path])),
        ...status.untracked,
      ]),
    ],
    request,
  );
}

async function publish(request: Request, cwd: string, branch: string, files: string[]) {
  const options = { ...writeOptions, cwd };
  await git.add({ args: files }, options);
  await git.commit({ flags: { message: request.prTitle } }, options);
  await git.push({ args: ["origin", branch], flags: { setUpstream: true } }, options);

  const result = await sh.exec(
    [
      "gh",
      "pr",
      "create",
      "--repo",
      "unify-apps/uacode",
      "--base",
      request.base,
      "--head",
      branch,
      "--title",
      request.prTitle,
      "--body",
      pullRequestBody(request, files),
    ],
    options,
  );

  const url = result.stdout.trim();

  if (!/^https:\/\/github\.com\/unify-apps\/uacode\/pull\/\d+$/.test(url)) {
    throw new Error(
      "Could not verify the resulting uacode pull request URL. Inspect the generated branch on GitHub.",
    );
  }

  return url;
}

async function selectedBase(request: Request) {
  const cwd = request.repository;
  const options = { ...readOptions, cwd };

  const remote = await sh.exec(
    ["git", "ls-remote", "--exit-code", "origin", `refs/heads/${request.base}`],
    options,
  );

  const sha = remote.stdout.trim().split(/\s+/)[0] ?? "";

  if (!/^[a-f0-9]{40,64}$/.test(sha)) {
    throw new Error("Origin returned an invalid base SHA. Verify the selected remote branch.");
  }

  if (request.dryRun) {
    const head = await git.revParse({ args: ["HEAD"] }, options);

    if (head !== sha) {
      throw new Error(
        "Preview requires HEAD at the selected origin base. Use a checkout at that commit.",
      );
    }

    return head;
  }

  await git.fetch({ args: ["origin", sha] }, { ...writeOptions, cwd });

  return git.revParse({ args: [`${sha}^{commit}`], flags: { verify: true } }, options);
}

async function apply(request: Request, base: string, branch: string, worktree: string) {
  const options = { ...writeOptions, cwd: request.repository };
  await git.worktree.add({ args: [worktree, base], flags: { b: branch } }, options);

  try {
    const result = await synchronize(request, base, worktree);
    const summary = parseSummary(result.stdout, request);
    const files = await inspectChanges(request, { cwd: worktree, base, branch });
    const prUrl = files.length ? await publish(request, worktree, branch, files) : null;

    return { base, branch, files, dryRun: false, prUrl, ...summary };
  } finally {
    await git.worktree.remove({ args: [worktree], flags: { force: true } }, options);
    await git.branch.raw({ args: [branch], flags: { delete: true, force: true } }, options);
  }
}
