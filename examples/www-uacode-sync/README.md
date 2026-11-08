# Sync www agent assets to uacode

Not runnable until PR 7 migrates this workflow to the graph builder. `www-uacode-sync.loopy.ts` and `github.ts` still use the removed step SDK, so `loopy save` rejects them. The current-API sketch is `packages/sdk/_tests_/fixtures/graph-examples/www-sync.ts`.

This loopy copies the three www agent prompts and nine UAC skills into uacode JSON assets. It pins GitHub source and target refs to immutable SHAs, reads each source file with its own command, and computes changes with pure functions.

Workflow Agent instructions come from `packages/uac/docs/agent-prompt.md`. Its generated block in `.claude/agents/workflow-agent.md` must match. Maintainer-only comments are stripped. Planner and AI FDE prompts come from their `.claude/agents` files; skills come from `packages/uac/skills/<name>/SKILL.md`.

The transforms preserve existing agent names, unrelated fields, export versions and JSON layout. They synchronize standalone and embedded skill bodies, add missing manifest registrations and bump each affected feature's patch release once. Mismatched standalone and embedded skill versions fail validation.

The workflow needs Git, Bun and `gh` authenticated for both private repositories, plus a local uacode checkout whose origin is `unify-apps/uacode`. It leaves local edits in that checkout alone. Git publication uses your configured Git identity and credentials.

`repository` must be absolute. Optional `sourceRef` defaults to `main`; `targetBranches` is a comma-separated list, defaulting to `main,uat`. Each branch's JSON result lists the pinned base, generated branch, changed files and PR URL. There is no standalone helper CLI or patch-directory mode.

Preview reads remote content, computes the proposed files and validates any existing generated branch. Unchanged snapshots return before PR lookup or branch verification. It logs skipped writes and performs no fetch, worktree creation, file write, staging, commit, push, PR edit or cleanup.

Apply fetches the pinned commits and creates a detached sibling worktree per changed target. Each file write, diff check, stage, commit, push and PR operation is its own command. It removes the worktree in `finally`, including after ordinary failures. Read commands retry nonzero exits up to three attempts with a two-minute timeout. Write commands use one attempt and a ten-minute timeout. An interrupted activation can leave its worktree until resumed; inspect the recorded path before manually cleaning up a cancelled run.

A single open generated sync PR is reused across source changes. Before updating a generated branch, Loopy recomputes the source/base transformation recorded in its commit and compares the planned paths and blob SHAs with one GitHub comparison response. The branch is checked even when it has no open PR. Manual edits, unknown metadata, duplicate PRs and missing or truncated comparison responses stop publication. Updates include the observed head and current base in their ancestry and use a normal push; a concurrent push rejects the update. Equal trees skip the commit and push, while refreshing PR text. Unchanged snapshots skip publication entirely.

`sync.ts` contains only source validation, agent/skill mapping, release updates and PR text. `json-edit.ts` patches an in-memory file snapshot while retaining JSON formatting. `publication.ts` validates input and GitHub metadata. `github.ts` owns GitHub reads. `verify.ts` verifies generated branches against planned blob hashes. The loopy owns publication. GitHub API calls are reads; publication uses Git and `gh pr create` or `gh pr edit`.

Helper tests live in `examples/_tests_/helpers.test.ts`. Run `bun test ./examples/_tests_`. Pure fixtures cover JSON preservation, registrations, release versions, generated-branch metadata and manual-edit rejection. They never read private repositories or publish PRs.
