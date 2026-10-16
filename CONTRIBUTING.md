# Contributing

Bun 1.4 or newer. Run `bun install`, then `bun run check` before pushing. It builds, lints, typechecks and runs the tests. Read [AGENTS.md](AGENTS.md) for code ownership and conventions.

One package, `packages/loopy`, exposes `loopy` for authors, `loopy/runtime` for the replay engine and `loopy/local` for OS adapters. Studio views saved loopies, runs, step traces and logs. Author definitions in TypeScript.

Core and runtime stay portable. The portable typecheck, browser-bundle test and architecture test enforce this. SDK imports core and runtime, with one `node:async_hooks` import for shared activation scope. Local owns SQLite, paths, subprocesses, sandboxing and secrets. The CLI wires these pieces together. Another execution host implements `RunStore` and `Executor`.

Tests live in `_tests_` directories and cover type guarantees, parsers, sandbox confinement, durable transitions and CLI behavior. Use temporary homes and fake executors. Skip tests for glue.

Runtime and store invariants:

- A run keeps its input, workspace and bundle hash after creation.
- Successful steps replay their persisted result in recorded completion order.
- Every write is fenced by the active owner token.
- An unfinished effect can repeat after a crash; design external actions to be idempotent.
- Workflow logs deduplicate by replay position; step logs retain each executed attempt.
- Schema changes recreate local tables with a version bump instead of migrations.
- Sandbox execution fails closed.
