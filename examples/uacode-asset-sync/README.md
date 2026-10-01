# Uacode asset sync loop

This example delegates export and asset synchronization to Codex in a detached disposable uacode
worktree. The runner validates the request, checks the origin repository, fetches the exact selected
base, and requires its checked-in sync script before launching Codex. It checks the resulting diff
and reads back the PR URL. The source checkout can have local edits; Codex works in the new worktree.

Merge [unify-apps/uacode#40724](https://github.com/unify-apps/uacode/pull/40724) first. The runner fails
closed if `scripts/platform-feature-assets/sync-t2w-assets.mjs` is absent on the selected base. Install
Bun, Codex, Git, and `gh`, and authenticate `gh` for uacode. Never run Gradle or Spotless for this loop.

## Run

Create `/tmp/asset-sync-request.json` with non-secret inputs:

```json
{
  "repository": "/path/to/uacode",
  "assets": [{"assetClass": "WORKFLOW_DEFINITION", "assetId": "your-asset-id", "assetVersion": "11"}],
  "exportDirectory": "/path/to/extracted-export",
  "dryRun": true
}
```

Save the graph and run it with the Loopy repository as its working directory. The runner path is
relative to that directory, even when the saved graph is global:

```sh
loopy save /path/to/loopy/examples/uacode-asset-sync/asset-sync-pr.loopy.ts
loopy run uacode-asset-sync --cwd /path/to/loopy --full \
  --input '{"requestFile":"/tmp/asset-sync-request.json"}'
```

`requestFile` must be readable at execution time. Its contents are validated by the runner, rather
than serialized into the saved graph. Saving creates no worktree and performs no export.

Omit `exportDirectory` to request a fresh UAT export. Set `UA_ASSET_EXPORT_WEBHOOK_URL` privately in
the inherited environment before running. The source automation is
[Loopy asset export](https://agent-code-migration.uat.unifyapps.com/p/0/automations/6a99f5b5ff996660f72b33ad/preview).
Do not put the webhook or signed download URL in the request file or Loopy inputs. The runner never
prints the webhook value and discards Codex stdout and stderr. Codex performs the network calls;
its own tool traces may retain URLs. The prompt tells it to keep URLs out of output and files and
to remove temporary download data after use.

Each asset requires non-empty `assetClass` and `assetId` strings; `assetVersion` is an optional
non-empty string. Options default to:

| Option | Default |
| --- | --- |
| `feature` | `ai-agents` |
| `indexPath` | `configs/platform-features/ai-agents/platform/ai-sdlc/text-to-workflow-assets.json` |
| `baseBranch` | `main` |
| `branchPrefix` | `loopy/uacode-asset-sync` |
| `prTitle` | `Sync exported T2W assets` |
| `exportDirectory` | Empty, request a UAT export |
| `dryRun` | `false` |

Set `dryRun` explicitly to `true` for a preview. The prompt forbids tracked edits, branch creation,
commits, pushes, and PR creation during preview. The runner checks for unchanged HEAD, detached
state, and a clean worktree afterwards. These checks detect violations after Codex returns; Codex
has full permissions, so they cannot undo a publication. Apply mode creates a unique branch, runs
apply/check and the sync script's Node tests, restricts changes to the selected asset repository and
exact index, then opens one non-draft PR using `prTitle`. It never merges, approves, or closes PRs.

Successful runs remove the disposable worktree. Failed runs retain it and print its path for
inspection. Remove it with `git -C /path/to/uacode worktree remove --force <retained-path>` after
reviewing the failure. A cancelled process may also leave a worktree. The command gets a one-hour
Codex timeout and does not stream agent progress or its final prose; its JSON result includes the
base SHA, branch, changed files, proposed preview paths, reported checks, preview flag, and PR URL
when changes were published. Proposed paths and check names come from a validated structured final
message; check names are agent-reported, while the runner separately verifies Git state.

## Fixture checks

```sh
bun test examples/uacode-asset-sync/_tests_
```

These tests use fake Codex commands and both fake Git commands and a temporary local Git fixture.
The local fixture fetches only itself and checks that a dirty source checkout survives an isolated
run. They never contact UAT, fetch uacode, or publish PRs.
