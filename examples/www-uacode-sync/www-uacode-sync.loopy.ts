import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { git, log, loopy, sh, step } from "loopy";
import { readOptions, writeOptions } from "../options.ts";
import { findPullRequest, readSnapshot, remoteSha } from "./github.ts";
import { validateInput } from "./publication.ts";
import {
  type Files,
  planSync,
  pullRequestBody,
  sourceFiles,
  syncCommitMessage,
  targetFiles,
} from "./sync.ts";
import { verifyExisting } from "./verify.ts";

export default loopy({
  name: "www-uacode-sync",
  description: "Copy www prompts and skills into uacode assets and open a PR per changed branch.",
  mode: "full",
  input: {
    repository: "string",
    dryRun: "boolean",
    "sourceRef?": "string",
    "targetBranches?": "string",
  },
  run: async ({ input, uuid }) => {
    const options = validateInput(input);
    await prerequisites(options.repository);
    const sourceSha = await requireRef("www", options.sourceRef);
    const source = await readSnapshot("www", sourceSha, sourceFiles);
    const id = await uuid();
    const results = [];

    for (const branch of options.targetBranches) {
      results.push(await syncBranch({ ...options, branch, sourceSha, source, id }));
    }

    log.info("Prompt and skill synchronization completed.", { dryRun: options.dryRun });

    return { sourceSha, dryRun: options.dryRun, results };
  },
});

async function prerequisites(cwd: string) {
  const top = await git.revParse({ flags: { showToplevel: true } }, { ...readOptions, cwd });

  if (resolve(top) !== resolve(cwd)) {
    throw new Error(
      "Repository must be the checkout root. Supply the path returned by git rev-parse --show-toplevel.",
    );
  }

  const remotes = await git.remote(undefined, { ...readOptions, cwd });

  if (
    !remotes.some(
      (remote) =>
        remote.name === "origin" &&
        /^(?:git@github\.com:|https:\/\/github\.com\/|ssh:\/\/git@github\.com\/)unify-apps\/uacode(?:\.git)?$/.test(
          remote.fetch ?? "",
        ),
    )
  ) {
    throw new Error("Origin must be unify-apps/uacode on github.com. Use the correct checkout.");
  }
}

type BranchOptions = ReturnType<typeof validateInput> & {
  branch: string;
  sourceSha: string;
  source: Files;
  id: string;
};

type BranchResult = {
  branch: string;
  branchName: string;
  base: string;
  changed: string[];
  pullRequest: string | null;
};

async function requireRef(repo: string, ref: string) {
  const sha = await remoteSha(repo, ref);

  if (!sha) {
    throw new Error(`Missing ${repo} branch ${ref}. Choose an existing source or target branch.`);
  }

  return sha;
}

async function syncBranch(options: BranchOptions) {
  const { branch, sourceSha, source } = options;
  const base = await requireRef("uacode", branch);
  const target = await readSnapshot("uacode", base, targetFiles);
  const changes = planSync(source, target, sourceSha);
  const branchName = `chore/www-agent-assets-${sourceSha.slice(0, 8)}-${branch.replaceAll(/[^a-zA-Z0-9-]/g, "-")}`;

  const result: BranchResult = {
    branch,
    branchName,
    base,
    changed: changes.map((change) => change.path),
    pullRequest: null,
  };

  if (!changes.length) {
    log.info(`no changes on ${branch}`);

    return result;
  }

  return syncChangedBranch(options, result, changes);
}

async function syncChangedBranch(
  options: BranchOptions,
  result: BranchResult,
  changes: ReturnType<typeof planSync>,
) {
  const existing = await findPullRequest(options.branch);
  const branchName = existing?.headRefName ?? result.branchName;
  const sha = await remoteSha("uacode", branchName);
  const observed = sha ? await verifyExisting(sha) : null;

  if (existing && !observed) {
    throw new Error(
      "The open sync PR has no remote branch. Restore or close the PR before retrying.",
    );
  }

  const next = { ...result, branchName, pullRequest: existing?.url ?? null };

  if (options.dryRun) {
    log.info("Dry run: skip fetch, worktree, file writes, staging, commit, push, PR and cleanup.", {
      branch: options.branch,
    });

    return next;
  }

  return publishBranch({
    options,
    base: result.base,
    branchName,
    changes,
    observed,
    existing,
    result: next,
  });
}

type Publication = {
  options: BranchOptions;
  cwd: string;
  base: string;
  branchName: string;
  changes: ReturnType<typeof planSync>;
  observed: { sha: string; tree: string } | null;
  existing: Awaited<ReturnType<typeof findPullRequest>>;
};

async function publishBranch(input: Omit<Publication, "cwd"> & { result: BranchResult }) {
  const { options, base, observed, result } = input;
  const { repository, branch } = options;
  const cwd = `${repository}-loopy-${options.id}-${branch.replaceAll("/", "-")}`;
  const commands = { ...writeOptions, cwd: repository };
  await git.fetch({ args: ["origin", base] }, commands);

  if (observed) {
    await git.fetch({ args: ["origin", observed.sha] }, commands);
  }

  await git.worktree.add({ args: [cwd, observed?.sha ?? base], flags: { detach: true } }, commands);

  try {
    return { ...result, pullRequest: await publish({ ...input, cwd }) };
  } finally {
    await git.worktree.remove({ args: [cwd], flags: { force: true } }, commands);
  }
}

async function publish(publication: Publication) {
  const { options, cwd, base, branchName, changes, observed } = publication;
  const commands = { ...writeOptions, cwd };

  if (observed) {
    await sh.exec(["git", "merge", "--no-commit", "--no-ff", "-s", "ours", base], commands);
    await sh.exec(["git", "read-tree", "--reset", "-u", base], commands);
  }

  for (const { path, contents } of changes) {
    await step(
      `write ${path}`,
      async () => {
        await mkdir(dirname(join(cwd, path)), { recursive: true });

        return Bun.write(join(cwd, path), contents);
      },
      writeOptions,
    );
  }

  const tree = await stage(cwd, base);

  if (!observed || tree !== observed.tree) {
    await git.commit({ flags: { message: syncCommitMessage(options.sourceSha, base) } }, commands);
    await git.push({ args: ["origin", `HEAD:refs/heads/${branchName}`] }, commands);
  }

  return publishPullRequest(publication);
}

async function stage(cwd: string, base: string) {
  const diff = await git.diff({ revisions: [base] }, { ...readOptions, cwd });
  const paths = diff.flatMap((file) => (file.from ? [file.from, file.path] : [file.path]));

  if (paths.some((path) => !targetFiles.includes(path))) {
    throw new Error(
      "Sync changed an unapproved path. Inspect the generated worktree before retrying.",
    );
  }

  await sh.exec(["git", "diff", "--check", base], { ...readOptions, cwd });
  await git.add({ args: targetFiles }, { ...writeOptions, cwd });

  return (await sh.exec(["git", "write-tree"], { ...writeOptions, cwd })).stdout.trim();
}

async function publishPullRequest(publication: Publication) {
  const { options, cwd, base, branchName, changes, existing } = publication;

  const body = pullRequestBody(
    options.sourceSha,
    base,
    changes.map((change) => change.path),
  );

  const title = `Sync www agent assets (${options.sourceSha.slice(0, 8)})`;
  const details = ["--repo", "unify-apps/uacode", "--title", title, "--body", body];

  const result = await sh.exec(
    existing
      ? ["gh", "pr", "edit", existing.url, ...details]
      : ["gh", "pr", "create", "--base", options.branch, "--head", branchName, ...details],
    { ...writeOptions, cwd },
  );

  const url = existing?.url ?? result.stdout.trim();
  log.info(`PR ${existing ? "updated" : "created"} ${url}`);

  return url;
}
