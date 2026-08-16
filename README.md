# Loopy

Do the work once. Loopy extracts the reusable process, lets you edit it visually, and runs it again through your locally installed coding agents.

Phase 0 is implemented: the Bun workspace, versioned Zod contracts, deterministic JSON Schema fixtures, graph validation, and a CLI shell are available. Runtime execution, traces, artifacts, extraction, provider adapters, scheduling, and the visual Studio are not implemented yet. All operational features remain local-first; hosted infrastructure is out of scope.

## Current commands

```sh
bun install
bun run check       # format, lint, typecheck, contracts/runtime/CLI tests
bun run build       # emit contracts declarations and run the root typecheck
bun packages/cli/src/index.ts --help
```

The `loopy validate` and `loopy run` command names are reserved in the CLI surface, but command handlers are not implemented in Phase 0. No scheduler or provider execution is included.

## Plan

The canonical implementation plan is tracked at:

- [Loopy Local-First MVP Architecture and Roadmap](.planloft/plans/loopy-local-first-mvp.md)
