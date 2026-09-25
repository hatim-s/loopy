# Contributing

Use Bun 1.4 or newer. Run `bun install`, `bun run check`, `bun run fmt:check` and `bun run build` before submitting a change.

Keep the public package in `packages/loopy`. Add internal modules when they hide a distinct responsibility; do not create a package for each module. Studio only views definitions and runs them. Workflow edits belong in TypeScript.

Keep `core`, `runtime` and `cloud` free of Bun, Node and OS access. The runtime accepts storage and execution adapters; `local` owns SQLite, paths and subprocesses. The CLI composes local adapters. Add a hosted adapter against these contracts instead of importing local behavior into the execution engine. Portable typechecking and browser bundling enforce this boundary.

Put tests in `packages/loopy/_tests_`. Focus them on compilation and type guarantees, subprocess confinement, durable state transitions and end-to-end CLI behavior. Test a packed installation when package exports or assets change.

Treat each run's graph, input, mode and workspace as immutable. Never silently replay an uncertain external command. Commit checkpoint output and its event atomically in the repository and fence writes with the current owner token. Distributed adapters must expire leases and recover abandoned attempts as uncertain. Sandbox execution must fail closed.
