# Uacode asset sync

This loopy asks Codex to preview or synchronize requested exported assets. Loopy checks the repository, pins the selected remote base, inspects the diff, then stages, commits, pushes and opens one PR. Each command has its own durable step. Codex never owns Git publication.

Require Bun, Git, Codex and authenticated `gh`. Merge [uacode#40724](https://github.com/unify-apps/uacode/pull/40724) first; the selected base must contain `scripts/platform-feature-assets/sync-t2w-assets.mjs`. Never run Gradle or Spotless for this automation.

## Run

Save from any directory with the `loopy` dependency available. Imported helpers are bundled, so later runs do not need the Loopy checkout:

```sh
loopy save /path/to/loopy/examples/uacode-asset-sync/asset-sync-pr.loopy.ts
loopy run uacode-asset-sync --repository /path/to/uacode \
  --assetsJson '[{"assetClass":"WORKFLOW_DEFINITION","assetId":"your-asset-id","assetVersion":"11"}]' \
  --exportDirectory /path/to/extracted-export --dryRun true
```

Inputs are non-secret. `repository` and `exportDirectory` must be absolute. Each asset needs a nonempty `assetClass` and `assetId`; `assetVersion` is optional. The export directory must contain exactly one root with `CHANGESET`.

Preview checks the latest remote SHA without fetching or creating a worktree. Fetch the selected base into your checkout first and check it out before previewing. Preview uses Codex's read-only sandbox, verifies that HEAD, status and tracked diff remain unchanged, and logs the skipped writes. An extracted `exportDirectory` is required for preview. Codex's proposed changes appear in its recorded command output; the result's `files` list contains actual changes, so it is empty for a preview.

Apply with `--dryRun false`. Loopy fetches the exact selected SHA, creates a uniquely named sibling worktree, asks Codex to run preview/apply/check and dedicated Node tests when present, then verifies unchanged HEAD and branch, unstaged changes, allowed paths and `git diff --check`. It publishes only changes within the selected asset repository and exact index. Checks performed inside Codex remain agent-reported. No diff means no commit or PR. Loopy never merges, approves or closes PRs.

Apply can omit `exportDirectory` to request a fresh UAT export through `UA_ASSET_EXPORT_WEBHOOK_URL` in Codex's inherited environment. The prompt requires safe archive paths and deletion of temporary downloads. Do not put the webhook or signed download URL in input. Command output and stdin are retained; Codex must keep credentials and URLs out of its output and files.

Optional inputs default to:

| Input | Default |
| --- | --- |
| `feature` | `ai-agents` |
| `indexPath` | `configs/platform-features/ai-agents/platform/ai-sdlc/text-to-workflow-assets.json` |
| `baseBranch` | `main` |
| `branchPrefix` | `loopy/uacode-asset-sync` |
| `prTitle` | `Sync exported T2W assets` |

The worktree is removed in `finally`, including after ordinary failures. Git commands use one attempt; Codex has a one-hour timeout. An interrupted activation can leave its worktree until resumed. Inspect the recorded path before removing a cancelled run's worktree manually.

`run.ts` now contains only request parsing and defaults. `prompt.ts` contains prompt text, allowed-path checks and PR body formatting. Neither spawns commands or reads files.

Tests live in `packages/loopy/_tests_/examples.test.ts` and `examples-helpers.test.ts`. Run `bun test packages/loopy/_tests_/examples`. They use recording executors and bundled definitions, never UAT or real PR publication.
