import type { Request } from "./request.ts";

export function syncPrompt(request: Request, base: string) {
  return [
    "Read AGENTS.md and repository instructions. Never run Gradle or Spotless.",
    "Synchronize only the requested exported assets and their required index entries.",
    "Never create branches, commit, push, open PRs, merge, approve or close PRs.",
    "The Loopy workflow owns Git state and publication. Do not change HEAD or the index.",
    `Use scripts/platform-feature-assets/sync-t2w-assets.mjs from base ${base}.`,
    "Require exactly one export root containing CHANGESET in exportDirectory.",
    "If exportDirectory is empty, require UA_ASSET_EXPORT_WEBHOOK_URL in the inherited environment.",
    "POST the assets as JSON to it, require exportUrl, download and extract into a temporary directory.",
    "Reject archive entries with absolute paths or parent traversal before extraction.",
    "Never print or persist credentials, webhook responses or signed URLs. Remove temporary downloads.",
    "Run the sync script with --dry-run, --feature and --index from the request.",
    request.dryRun
      ? "Preview only. Do not edit tracked files or the index. Report proposed paths and checks."
      : "Run --apply, then --check. Run the dedicated Node tests when present. Leave changes uncommitted.",
    "Your final message must be ONLY JSON { proposedFiles, checks }. List repository-relative proposed paths and only performed check names: sync-preview, sync-check, node-test, diff-check. Include no URLs, secrets, command output or extra fields.",
    `Validated request: ${JSON.stringify(request)}`,
  ].join("\n");
}

export function changedFiles(paths: string[], request: Request) {
  const root = `configs/platform-features/${request.feature}/asset-repository/`;

  if (
    paths.some(
      (path) =>
        !/^[a-zA-Z0-9_./@-]+$/.test(path) ||
        path.split("/").some((part) => !part || part === "." || part === "..") ||
        (path !== request.indexPath && !path.startsWith(root)),
    )
  ) {
    throw new Error(
      "Sync changed files outside the selected asset repository and index. Inspect the changes before retrying.",
    );
  }

  return paths;
}

export function pullRequestBody(request: Request, files: string[]) {
  return [
    "Sync requested T2W assets.",
    "",
    "Requested assets:",
    ...request.assets.map(
      (asset) => `- ${asset.assetClass}: ${asset.assetId} (${asset.assetVersion ?? "latest"})`,
    ),
    "",
    "Changed paths:",
    ...files.map((file) => `- ${file}`),
    "",
    "Checks requested from Codex: sync preview, sync check, dedicated Node tests when present.",
    "Verified by Loopy: unchanged HEAD, allowed paths, git diff --check.",
    "Source automation: https://agent-code-migration.uat.unifyapps.com/p/0/automations/6a99f5b5ff996660f72b33ad/preview",
  ].join("\n");
}

// BOUNDARY: Codex's final stdout is untrusted JSON containing only paths and performed checks.
function summaryJson(stdout: string) {
  let summary: unknown;

  try {
    summary = JSON.parse(stdout);
  } catch {
    throw new Error("Missing or invalid Codex summary. Ask Codex to return only summary JSON.");
  }

  return summary;
}

// BOUNDARY: The final summary permits only allowed paths and known check names.
export function parseSummary(stdout: string, request: Request) {
  const summary = summaryJson(stdout);

  if (
    !summary ||
    typeof summary !== "object" ||
    Array.isArray(summary) ||
    Object.keys(summary).some((key) => !["proposedFiles", "checks"].includes(key))
  ) {
    throw new Error("Invalid Codex summary. Return only proposedFiles and checks arrays.");
  }

  if (
    !("proposedFiles" in summary) ||
    !Array.isArray(summary.proposedFiles) ||
    !summary.proposedFiles.every((path: unknown): path is string => typeof path === "string")
  ) {
    throw new Error("Invalid proposed-file summary from Codex. Return repository-relative paths.");
  }

  if (
    !("checks" in summary) ||
    !Array.isArray(summary.checks) ||
    !summary.checks.every(
      (check: unknown): check is string =>
        typeof check === "string" &&
        ["sync-preview", "sync-check", "node-test", "diff-check"].includes(check),
    )
  ) {
    throw new Error("Invalid check summary from Codex. Return only known performed check names.");
  }

  return { proposedFiles: changedFiles(summary.proposedFiles, request), checks: summary.checks };
}
