import type { Request } from "./run.ts";

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
    `Validated request: ${JSON.stringify(request)}`,
  ].join("\n");
}

export function changedFiles(paths: string[], request: Request) {
  const root = `configs/platform-features/${request.feature}/asset-repository/`;

  if (paths.some((path) => path !== request.indexPath && !path.startsWith(root))) {
    throw new Error("Sync changed files outside the selected asset repository and index.");
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
