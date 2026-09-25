# Sync www agent assets to uacode

This Loopy workflow copies the three current www agent prompts and nine UAC skills into matching uacode JSON assets. It reads `packages/uac/docs/agent-prompt.md` for Workflow Agent instructions and checks that the generated block in `.claude/agents/workflow-agent.md` matches it. If the canonical prompt has a maintainer-only HTML comment, the helper removes it from the uacode asset. Planner and AI FDE instructions come from `.claude/agents/solution-planner.md` and `.claude/agents/ai-fde.md`. It keeps each asset's existing agent name and uses the source description and prompt body. Skills come from their `packages/uac/skills/<name>/SKILL.md` files.

The helper edits the three agent `instructions` fields, nine registered skill `skill` fields, embedded Workflow Agent skill bodies, missing manifest registrations, and release records for affected `ai-fde`, `solution-builder`, and `text-to-workflow` features. It increments each affected feature's patch release version once and records the source www SHA. It preserves other asset fields and exported asset version markers, and fails if a standalone skill version disagrees with its embedded copy. It skips unchanged branches, reuses the single open generated sync PR for a base across source SHA changes, and updates that branch and PR title/body.

## Run after the www change merges

From the Loopy checkout, save the workflow once:

```sh
bun run loopy save examples/www-uacode-sync/www-uacode-sync.loopy.ts
```

Run the preview first. The helper reads current GitHub `main` and uacode `main`/`uat` by API, pins every content read to the returned commit SHA, and stages changes in a temporary directory. It does not rely on local branch refs.

```sh
bun run loopy run www-uacode-sync --full --input '{"dryRun":"true"}'
```

Review the JSON output and then run with `dryRun` set to `false` to push branches and open PRs:

```sh
bun run loopy run www-uacode-sync --full --input '{"dryRun":"false"}'
```

Apply mode uses authenticated GitHub CLI API calls to create one commit and branch per changed base, then `gh` to reuse or create the PR. Make sure `gh auth status` succeeds and the token can read both private repos, create branches, and open PRs. API and Git commands time out after 45 seconds and report failures without printing credentials.

For a readable local diff, run the helper directly with a patch directory. It still previews the latest remote refs and writes no branches or PRs:

```sh
bun run examples/www-uacode-sync/sync.ts --dry-run true --patch-dir /tmp/www-uacode-sync-patches
```

Review `main.patch` and `uat.patch` in that directory before setting `dryRun` to `false`.

## Local fixtures

The helper accepts local source and target repositories for synthetic dry-run work:

```sh
bun run examples/www-uacode-sync/sync.ts --source-repo /tmp/www-fixture --target-repo /tmp/uacode-fixture --source-ref main --target-branches main,uat --dry-run true
```

Fixture repos need an `origin` remote with the named refs and a matching generated Workflow Agent block. Local apply mode requires the expected repository origins. The temporary staging directory is removed on success or failure.
