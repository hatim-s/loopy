import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { instructions } from "./prompt.ts";

const script = "scripts/platform-feature-assets/sync-t2w-assets.mjs";

const defaults = {
  feature: "ai-agents",
  indexPath: "configs/platform-features/ai-agents/platform/ai-sdlc/text-to-workflow-assets.json",
  baseBranch: "main",
  branchPrefix: "loopy/uacode-asset-sync",
  prTitle: "Sync exported T2W assets",
  exportDirectory: "",
  dryRun: false,
};

type Asset = { assetClass: string; assetId: string; assetVersion?: string };

export type Request = typeof defaults & { assets: Asset[]; repository: string };

// BOUNDARY: Agent request fields must be nonempty strings without control characters.
function text(value: unknown, name: string): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    [...value].some((char) => char.charCodeAt(0) < 32)
  ) {
    throw new Error(`${name} must be a non-empty string without control characters`);
  }

  return value;
}

// BOUNDARY: Agent requests and summary JSON must be non-null objects before their allowed fields are validated.
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected a JSON object");
  }

  // SAFETY: The check above establishes a non-null, non-array object; each selected field remains unknown until validated.
  return value as Record<string, unknown>;
}

// BOUNDARY: Agent request JSON is checked for allowed keys, asset identities, repository and safe path options.
export function parseRequest(raw: unknown): Request {
  const input = object(raw);
  const allowed = new Set(["assets", "repository", ...Object.keys(defaults)]);

  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) {
      throw new Error(`Unknown option: ${key}`);
    }
  }

  if (!Array.isArray(input.assets) || !input.assets.length) {
    throw new Error("assets must be a non-empty array");
  }

  const assets = input.assets.map((value, i) => {
    const item = object(value);

    if (Object.keys(item).some((key) => !["assetClass", "assetId", "assetVersion"].includes(key))) {
      throw new Error(`Unknown assets[${i}] field`);
    }

    const asset: Asset = {
      assetClass: text(item.assetClass, `assets[${i}].assetClass`),
      assetId: text(item.assetId, `assets[${i}].assetId`),
    };

    if (item.assetVersion !== undefined) {
      asset.assetVersion = text(item.assetVersion, `assets[${i}].assetVersion`);
    }

    return asset;
  });

  const options = { ...defaults, ...input };
  const feature = text(options.feature, "feature");

  if (!/^[a-zA-Z0-9_-]+$/.test(feature)) {
    throw new Error("feature must be one directory name");
  }

  const indexPath = text(options.indexPath, "indexPath");

  if (
    isAbsolute(indexPath) ||
    indexPath.includes("\\") ||
    indexPath.split("/").some((part) => !part || part === "." || part === "..") ||
    !indexPath.startsWith(`configs/platform-features/${feature}/`) ||
    !indexPath.endsWith(".json")
  ) {
    throw new Error(
      "indexPath must be a repository-relative JSON path within the selected feature",
    );
  }

  if (typeof options.dryRun !== "boolean") {
    throw new Error("dryRun must be a boolean");
  }

  if (typeof options.exportDirectory !== "string") {
    throw new Error("exportDirectory must be a string");
  }

  return {
    assets,
    repository: resolve(text(input.repository, "repository")),
    feature,
    indexPath,
    baseBranch: text(options.baseBranch, "baseBranch"),
    branchPrefix: text(options.branchPrefix, "branchPrefix"),
    prTitle: text(options.prTitle, "prTitle"),
    exportDirectory: options.exportDirectory ? resolve(options.exportDirectory) : "",
    dryRun: options.dryRun,
  };
}

export type Execute = (args: string[], cwd: string, stdin?: string) => Promise<string>;

const execute: Execute = async (args, cwd, stdin) => {
  const child = Bun.spawn(args, {
    cwd,
    stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
    stdout: "pipe",
    stderr: "pipe",
  });

  const timeout = setTimeout(() => child.kill(), 3_600_000);

  try {
    const [stdout, , code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);

    // Agent output and command errors can contain export credentials. Do not forward them.
    if (code !== 0) {
      throw new Error(`${args[0]} ${args[1]} failed with exit code ${code}`);
    }

    return stdout;
  } finally {
    clearTimeout(timeout);
  }
};

export async function run(request: Request, exec: Execute = execute) {
  const git = (...args: string[]) => exec(["git", ...args], request.repository);
  const remote = (await git("remote", "get-url", "origin")).trim();

  if (
    !/^(?:git@github\.com:|https:\/\/github\.com\/|ssh:\/\/git@github\.com\/)unify-apps\/uacode(?:\.git)?$/.test(
      remote,
    )
  ) {
    throw new Error("origin must be unify-apps/uacode on github.com");
  }

  await git("check-ref-format", "--branch", request.baseBranch);
  await git("check-ref-format", "--branch", `${request.branchPrefix}-check`);
  await git("fetch", "origin", `refs/heads/${request.baseBranch}`);
  const base = (await git("rev-parse", "--verify", "FETCH_HEAD^{commit}")).trim();

  if (!/^[a-f0-9]{40,64}$/.test(base)) {
    throw new Error("Git returned an invalid base SHA");
  }

  try {
    await git("cat-file", "-e", `${base}:${script}`);
  } catch {
    throw new Error(
      "The selected base lacks the sync script. Merge unify-apps/uacode#40724 first.",
    );
  }

  if (!request.exportDirectory && !process.env.UA_ASSET_EXPORT_WEBHOOK_URL) {
    throw new Error("Set UA_ASSET_EXPORT_WEBHOOK_URL or supply exportDirectory");
  }

  const temporary = await mkdtemp(join(tmpdir(), "loopy-uacode-sync-"));
  const worktree = join(temporary, "worktree");
  let added = false;
  let completed = false;

  const cleanup = async () => {
    if (added) {
      try {
        await git("worktree", "remove", "--force", worktree);
      } catch {
        throw new Error(`Cleanup failed. Worktree retained for inspection: ${worktree}`);
      }
    }

    await rm(temporary, { recursive: true, force: true });
  };

  try {
    await git("worktree", "add", "--detach", worktree, base);
    added = true;
    const prompt = `${instructions}\n\nValidated request:\n${JSON.stringify(request)}\nExact base SHA: ${base}\nThe runner created this detached disposable worktree from the exact supplied base SHA. Use that SHA even if origin moves. Never fetch a different base. Do not operate in the source checkout. Do not log export URLs, webhook responses, environment credentials, or signed URLs. Do not use /tmp for instruction/output files containing these URLs. The runner discards agent output.\n`;
    const summaryPath = join(temporary, "summary.json");
    await exec(
      [
        "codex",
        "exec",
        "--dangerously-bypass-approvals-and-sandbox",
        "--ephemeral",
        "--output-last-message",
        summaryPath,
        "--cd",
        worktree,
        "-",
      ],
      worktree,
      `${prompt}\nYour final message must be ONLY JSON with proposedFiles as an array of repository-relative paths and checks as an array containing only these performed check names: sync-preview, sync-check, node-test, diff-check. For dryRun list the proposed asset and index paths from the preview. Include no URLs, secrets, command output, or other fields.`,
    );
    // BOUNDARY: Codex summary JSON is untrusted until proposed paths and performed check names are verified below.
    let summary: Record<string, unknown>;

    try {
      summary = object(JSON.parse(await Bun.file(summaryPath).text()));
    } catch {
      throw new Error("Missing or invalid Codex summary");
    }

    const allowedPath = (file: string) =>
      file === request.indexPath ||
      file.startsWith(`configs/platform-features/${request.feature}/asset-repository/`);

    function isSafeProposedFile(file: unknown): file is string {
      return (
        typeof file === "string" &&
        allowedPath(file) &&
        /^[a-zA-Z0-9_./@-]+$/.test(file) &&
        !file.split("/").some((part) => part === "..")
      );
    }

    function isPerformedCheck(check: unknown): check is string {
      return (
        typeof check === "string" &&
        ["sync-preview", "sync-check", "node-test", "diff-check"].includes(check)
      );
    }

    const proposedFiles = summary.proposedFiles;

    if (!Array.isArray(proposedFiles) || !proposedFiles.every(isSafeProposedFile)) {
      throw new Error("Invalid proposed-file summary from Codex");
    }

    const agentChecks = summary.checks;

    if (!Array.isArray(agentChecks) || !agentChecks.every(isPerformedCheck)) {
      throw new Error("Invalid check summary from Codex");
    }

    const inWorktree = (...args: string[]) => exec(["git", ...args], worktree);
    await inWorktree("diff", "--check", base);
    const status = await inWorktree("status", "--porcelain");

    if (status.trim()) {
      throw new Error("Agent left uncommitted or untracked changes");
    }

    const head = (await inWorktree("rev-parse", "HEAD")).trim();
    const branchName = (await inWorktree("rev-parse", "--abbrev-ref", "HEAD")).trim();
    const branch = branchName === "HEAD" ? "" : branchName;

    if (request.dryRun && (head !== base || branch)) {
      throw new Error("dryRun changed the base commit or created a branch");
    }

    const files = (await inWorktree("diff", "--name-only", "-z", base, "HEAD"))
      .split("\0")
      .filter(Boolean);

    if (
      files.some(
        (file) =>
          file !== request.indexPath &&
          !file.startsWith(`configs/platform-features/${request.feature}/asset-repository/`),
      )
    ) {
      throw new Error("Agent changed files outside the asset repository and selected index");
    }

    let prUrl: string | undefined;

    if (!request.dryRun && files.length) {
      prUrl = (
        await exec(["gh", "pr", "view", branch, "--json", "url", "--jq", ".url"], worktree)
      ).trim();

      if (!/^https:\/\/github\.com\/unify-apps\/uacode\/pull\/\d+$/.test(prUrl)) {
        throw new Error("Could not verify the resulting uacode pull request URL");
      }
    }

    completed = true;

    return { base, branch, files, dryRun: request.dryRun, prUrl, proposedFiles, agentChecks };
  } catch (error) {
    if (added) {
      throw new Error(
        `${error instanceof Error ? error.message : "Asset sync failed"}. Worktree retained for inspection: ${worktree}`,
      );
    }

    throw error;
  } finally {
    if (completed || !added) {
      await cleanup();
    }
  }
}

if (import.meta.main) {
  try {
    const requestFile = process.argv[2];

    if (!requestFile || process.argv.length !== 3) {
      throw new Error("Expected one request JSON file path");
    }

    const request = parseRequest(JSON.parse(await Bun.file(requestFile).text()));
    console.log(JSON.stringify(await run(request)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Asset sync failed");
    process.exitCode = 1;
  }
}
