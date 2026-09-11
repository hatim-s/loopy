# Uacode asset sync loop

This workflow requests an asset export from UAT, runs uacode's checked-in sync script, verifies the
result, and opens one focused pull request. Loopy runs it in a disposable Git worktree, so active
uacode checkouts stay untouched.

The UAT source was cloned and adapted as
[Loopy asset export](https://agent-code-migration.uat.unifyapps.com/p/0/automations/6a99f5b5ff996660f72b33ad/preview).
Its webhook accepts a non-empty `assets` array. Each item has `assetClass`, `assetId`, and an optional
`assetVersion`. The workflow groups assets by class and returns the `exportUrl` from uacode's
`syncOptions` endpoint.

## Prerequisites

- Merge [unify-apps/uacode#40724](https://github.com/unify-apps/uacode/pull/40724). The loop fails
  closed while `scripts/platform-feature-assets/sync-t2w-assets.mjs` is absent from the selected base.
- Copy the webhook URL from the deployed UAT workflow and expose it only to the Loopy process as
  `UA_ASSET_EXPORT_WEBHOOK_URL`. Do not commit it or pass it as a workflow input.
- Authenticate `gh` for `unify-apps/uacode`.

## Run

Import the workflow into the uacode project state:

```sh
loopy workflow import /path/to/loopy/examples/uacode-asset-sync/asset-sync-pr.json \
  --project /path/to/uacode
```

Inspect the export and proposed repository changes without editing files:

```sh
UA_ASSET_EXPORT_WEBHOOK_URL='copy-from-uat' loopy run \
  a4000000-0000-4000-8000-000000000001 \
  --version 1 --provider codex --live --project /path/to/uacode \
  --input '{"assets":[{"assetClass":"WORKFLOW_DEFINITION","assetId":"6a50d200b05e3e1c2eed8d84","assetVersion":"11"}],"dryRun":true}'
```

Set `dryRun` to `false` to create, validate, push, and open the PR. Use `exportDirectory` to test an
already extracted export without calling UAT. The loop never merges, approves, or closes a PR.
