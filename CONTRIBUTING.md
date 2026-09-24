# Contributing

Use Bun 1.4 or newer. Run `bun install`, `bun run check`, `bun run fmt:check` and `bun run build` before submitting a change.

Keep the public package in `packages/loopy`. Add internal modules when they hide a distinct responsibility; do not create a package for each module. Studio only views definitions and runs them. Workflow edits belong in TypeScript.

Put tests in `packages/loopy/_tests_`. Focus them on compilation and type guarantees, subprocess confinement, durable state transitions and end-to-end CLI behavior. Test a packed installation when package exports or assets change.

Treat each run's graph, input, mode and workspace as immutable. Never silently replay an uncertain external command. Commit checkpoint output and its event in one SQLite transaction. Sandbox execution must fail closed.
