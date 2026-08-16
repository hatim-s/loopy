# Contributing to Loopy

Thanks for helping build Loopy. The project is a local-first developer tool: source-controlled workflow definitions stay separate from per-project runtime state, provider credentials, traces, and artifacts.

## Before opening a change

- Read the [MVP architecture and roadmap](.planloft/plans/loopy-local-first-mvp.md).
- Keep changes within the package boundary they belong to.
- Do not commit provider credentials, `.loopy/` runtime state, raw private sessions, or generated artifacts.
- Keep provider-specific limitations explicit; do not silently emulate unsupported capabilities.

## Local checks

Install Bun, then run:

```sh
bun install
bun run check
```

The check command formats and lints the workspace, type-checks strict TypeScript, and runs Vitest. Tests that need an installed provider or paid account must be opt-in and clearly labelled.

## Pull requests

Describe the user-visible contract, package boundaries touched, and the checks you ran. Include fixture or migration notes when a persisted contract changes. Keep unrelated worktree changes out of the commit.
