# Sync www agent assets to uacode

This loopy copies the three www agent prompts and nine UAC skills into uacode JSON assets. It pins GitHub source and target refs to immutable SHAs, reads each file in its own command step, and computes changes with pure functions outside steps.

Workflow Agent instructions come from `packages/uac/docs/agent-prompt.md`. Its generated block in `.claude/agents/workflow-agent.md` must match. Maintainer-only comments are stripped. Planner and AI FDE prompts come from their `.claude/agents` files; skills come from `packages/uac/skills/<name>/SKILL.md`.

The transforms preserve existing agent names, unrelated fields, export versions and JSON layout. They synchronize standalone and embedded skill bodies, add missing manifest registrations and bump each affected feature's patch release once. Mismatched standalone and embedded skill versions fail validation.

## Run

Install Git, Bun and `gh`, authenticate `gh` for both private repositories, and provide a local uacode checkout whose origin is `unify-apps/uacode`. Its local edits are left in place. Git publication uses your configured Git identity and credentials.

```sh
loopy save /path/to/loopy/examples/www-uacode-sync/www-uacode-sync.loopy.ts
loopy run www-uacode-sync --repository /path/to/uacode --dryRun true
loopy run www-uacode-sync --repository /path/to/uacode --dryRun false
```

`repository` must be absolute. Optional `sourceRef` defaults to `main`; `targetBranches` is a comma-separated list, defaulting to `main,uat`. Each branch's JSON result lists the pinned base, generated branch, changed files and PR URL. Saved bundles include all helper modules and work from any cwd. There is no standalone helper CLI or patch-directory mode.

Preview reads remote content, computes the proposed files and validates any existing generated branch. Unchanged snapshots return before PR lookup or branch verification. It logs skipped writes and performs no fetch, worktree creation, file write, staging, commit, push, PR edit or cleanup.

Apply fetches the pinned commits and creates a detached sibling worktree per changed target. Each file write, diff check, stage, commit, push and PR operation is a separate step. It removes the worktree in `finally`, including after ordinary failures. Read commands retry nonzero exits up to three attempts with a two-minute timeout. Write commands use one attempt and a ten-minute timeout. An interrupted activation can leave its worktree until resumed; inspect the recorded path before manually cleaning up a cancelled run.

A single open generated sync PR is reused across source changes. Before updating a generated branch, Loopy recomputes the source/base transformation recorded in its commit and compares the planned paths and blob SHAs with one GitHub comparison response. The branch is checked even when it has no open PR. Manual edits, unknown metadata, duplicate PRs and missing or truncated comparison responses stop publication. Updates include the observed head and current base in their ancestry and use a normal push; a concurrent push rejects the update. Equal trees skip the commit and push, while refreshing PR text. Unchanged snapshots skip publication entirely.

`sync.ts` contains only source validation, agent/skill mapping, release updates and PR text. `json-edit.ts` patches an in-memory file snapshot while retaining JSON formatting. `publication.ts` validates input and GitHub metadata. `github.ts` owns GitHub reads. `verify.ts` verifies generated branches against planned blob hashes. The loopy owns publication. GitHub API calls are reads; publication uses Git and `gh pr create` or `gh pr edit`.

Tests live in `packages/loopy/_tests_/examples.test.ts` and `examples-helpers.test.ts`. Run `bun test packages/loopy/_tests_/examples`. Recording executors cover preview, publication, PR reuse, failure cleanup, unchanged inputs and bundles run outside the checkout. Pure fixtures cover JSON preservation, registrations, release versions and manual-edit rejection. They never read private repositories or publish PRs.
