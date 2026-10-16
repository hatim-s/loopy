import { fs, git, log, loopy, sh, step } from "loopy";
import { parseTree, patchTree } from "./git-tree.ts";
import { parseCommit, parsePullRequests, selectPullRequest, validateInput } from "./publication.ts";
import {
  type Files,
  planSync,
  pullRequestBody,
  sourceFiles,
  syncCommitMessage,
  syncMetadata,
  targetFiles,
} from "./sync.ts";

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
  run: async ({ input, log, uuid }) => {
    const options = await step("www-sync-options", () => validateInput(input));
    await git.revParse({ flags: { showToplevel: true } }, { cwd: options.repository });
    await fs.stat({ args: [options.repository] });
    const remotes = await git.remote(undefined, { cwd: options.repository });

    if (
      !remotes.some(
        (remote) =>
          remote.name === "origin" &&
          /^(?:git@github\.com:|https:\/\/github\.com\/|ssh:\/\/git@github\.com\/)unify-apps\/uacode(?:\.git)?$/.test(
            remote.fetch ?? "",
          ),
      )
    ) {
      throw new Error("Origin must be unify-apps/uacode on github.com.");
    }

    const sourceSha = await remoteSha("www", options.sourceRef);
    const source = await readSnapshot("www", sourceSha, sourceFiles);
    const id = await uuid();
    const results = [];

    for (const branch of options.targetBranches) {
      results.push(await syncBranch({ ...options, branch, sourceSha, source, id }));
    }

    log.info("Prompt and skill synchronization completed.", { dryRun: input.dryRun });

    return { sourceSha, dryRun: input.dryRun, results };
  },
});

type BranchOptions = ReturnType<typeof validateInput> & {
  branch: string;
  sourceSha: string;
  source: Files;
  id: string;
};

async function remoteSha(repo: string, ref: string) {
  const result = await sh.exec([
    "gh",
    "api",
    `repos/unify-apps/${repo}/git/ref/heads/${encodeURIComponent(ref)}`,
    "--jq",
    ".object.sha",
  ]);

  const sha = result.stdout.trim();

  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error("GitHub returned an invalid commit SHA.");
  }

  return sha;
}

async function readSnapshot(repo: string, sha: string, paths: string[]) {
  const files: Files = {};

  for (const path of paths) {
    const result = await sh.exec([
      "gh",
      "api",
      "-H",
      "Accept: application/vnd.github.raw+json",
      `repos/unify-apps/${repo}/contents/${path}?ref=${sha}`,
    ]);

    files[path] = result.stdout;
  }

  return files;
}

async function syncBranch(options: BranchOptions) {
  const { branch, sourceSha, source, dryRun } = options;
  const base = await remoteSha("uacode", branch);
  const target = await readSnapshot("uacode", base, targetFiles);
  const changes = await step("www-sync-plan", () => planSync(source, target, sourceSha));
  const existing = await findPullRequest(branch);
  const observed = existing ? await verifyExisting(existing.headRefName) : null;

  const branchName =
    existing?.headRefName ??
    `chore/www-agent-assets-${sourceSha.slice(0, 8)}-${branch.replaceAll(/[^a-zA-Z0-9-]/g, "-")}`;

  const result = {
    branch,
    branchName,
    base,
    changed: changes.map((change) => change.path),
    pullRequest: existing?.url ?? null,
  };

  if (dryRun || !changes.length) {
    if (dryRun) {
      log.info(
        "Dry run: skip fetch, worktree, file writes, staging, commit, push, PR and cleanup.",
        { branch },
      );
    }

    return result;
  }

  return publishBranch({ options, base, branchName, changes, observed, existing, result });
}

async function findPullRequest(branch: string) {
  const listed = await sh.exec([
    "gh",
    "pr",
    "list",
    "--repo",
    "unify-apps/uacode",
    "--base",
    branch,
    "--state",
    "open",
    "--limit",
    "500",
    "--json",
    "url,headRefName",
  ]);

  return step("www-sync-pr", () => selectPullRequest(parsePullRequests(listed.stdout), branch));
}

type BranchResult = {
  branch: string;
  branchName: string;
  base: string;
  changed: string[];
  pullRequest: string | null;
};

async function publishBranch(input: Omit<Publication, "worktree"> & { result: BranchResult }) {
  const { options, base, branchName, changes, observed, existing, result } = input;
  const { repository, branch } = options;
  const worktree = `${repository}-loopy-${options.id}-${branch.replaceAll("/", "-")}`;
  await git.fetch({ args: ["origin", base] }, commandOptions(repository));

  if (observed) {
    await git.fetch({ args: ["origin", observed.sha] }, commandOptions(repository));
  }

  await git.worktree.add(
    { args: [worktree, observed?.sha ?? base], flags: { detach: true } },
    commandOptions(repository),
  );

  try {
    const pullRequest = await publish({
      options,
      worktree,
      base,
      branchName,
      changes,
      observed,
      existing,
    });

    return { ...result, pullRequest };
  } finally {
    await git.worktree.remove(
      { args: [worktree], flags: { force: true } },
      commandOptions(repository),
    );
  }
}

async function verifyExisting(branch: string) {
  const sha = await remoteSha("uacode", branch);
  const result = await sh.exec(["gh", "api", `repos/unify-apps/uacode/git/commits/${sha}`]);
  const commit = await step("www-sync-commit", () => parseCommit(result.stdout));
  const metadata = syncMetadata(commit.message);
  const source = await readSnapshot("www", metadata.source, sourceFiles);
  const target = await readSnapshot("uacode", metadata.base, targetFiles);
  await verifyTree(metadata, commit.tree, source, target);

  return { sha, tree: commit.tree };
}

type Publication = {
  options: BranchOptions;
  worktree: string;
  base: string;
  branchName: string;
  changes: ReturnType<typeof planSync>;
  observed: { sha: string; tree: string } | null;
  existing: ReturnType<typeof selectPullRequest>;
};

async function publish(publication: Publication) {
  const { options, worktree: cwd, base, branchName, changes, observed } = publication;

  if (observed) {
    await sh.exec(
      ["git", "merge", "--no-commit", "--no-ff", "-s", "ours", base],
      commandOptions(cwd),
    );
    await sh.exec(["git", "read-tree", "--reset", "-u", base], commandOptions(cwd));
  }

  for (const change of changes) {
    await sh.exec(["tee", "--", change.path], { ...commandOptions(cwd), stdin: change.contents });
  }

  const diff = await git.diff({ revisions: [base] }, commandOptions(cwd));

  const paths = diff.flatMap((file) => (file.from ? [file.from, file.path] : [file.path]));

  if (paths.some((path) => !targetFiles.includes(path))) {
    throw new Error("Sync changed an unapproved path.");
  }

  await sh.exec(["git", "diff", "--check", base], commandOptions(cwd));
  await git.add({ args: targetFiles }, commandOptions(cwd));
  const tree = (await sh.exec(["git", "write-tree"], commandOptions(cwd))).stdout.trim();

  if (!observed || tree !== observed.tree) {
    await git.commit(
      { flags: { message: syncCommitMessage(options.sourceSha, base) } },
      commandOptions(cwd),
    );
    await git.push({ args: ["origin", `HEAD:refs/heads/${branchName}`] }, commandOptions(cwd));
  }

  return publishPullRequest(publication);
}

async function publishPullRequest(publication: Publication) {
  const { options, worktree: cwd, base, branchName, changes, existing } = publication;

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
    commandOptions(cwd),
  );

  return existing?.url ?? result.stdout.trim();
}

function commandOptions(cwd: string) {
  return { cwd, retry: { attempts: 1 }, timeout: 45_000 };
}

async function verifyTree(
  metadata: ReturnType<typeof syncMetadata>,
  expected: string,
  source: Files,
  target: Files,
) {
  const result = await sh.exec([
    "gh",
    "api",
    `repos/unify-apps/uacode/git/commits/${metadata.base}`,
  ]);

  const base = await step("www-sync-base-commit", () => parseCommit(result.stdout));

  const changes = await step("www-sync-prior-plan", () =>
    planSync(source, target, metadata.source),
  );

  const tree = await reconstructTree(base.tree, changes);

  if (tree !== expected) {
    throw new Error("Refusing to update a sync branch with manual tree edits. Review it manually.");
  }
}

async function reconstructTree(sha: string, changes: ReturnType<typeof planSync>): Promise<string> {
  const result = await sh.exec(["gh", "api", `repos/unify-apps/uacode/git/trees/${sha}`]);
  const entries = await step("www-sync-read-tree", () => parseTree(result.stdout));
  const children: Record<string, string> = {};

  for (const entry of entries) {
    const prefix = `${entry.path}/`;

    const nested = changes
      .filter((change) => change.path.startsWith(prefix))
      .map((change) => ({ ...change, path: change.path.slice(prefix.length) }));

    if (nested.length) {
      children[entry.path] = await reconstructTree(entry.sha, nested);
    }
  }

  return step("www-sync-tree", () => patchTree(entries, changes, children));
}
