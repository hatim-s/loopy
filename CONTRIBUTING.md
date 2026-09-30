# Contributing

Bun 1.4 or newer. `bun install`, then `bun run check` before you push; it builds, lints, typechecks and runs the tests.

One package, `packages/loopy`, with four entry points: `core`, `runtime`, `local`, `cloud`. Add a module when it hides a distinct responsibility; don't add a package per module. Studio (`apps/studio`) only views and runs saved graphs. Workflow editing stays in TypeScript files.

`core`, `runtime` and `cloud` must not import Bun, Node or anything OS-specific. The portable typecheck and the browser-bundle test enforce that. `local` owns SQLite, paths and subprocesses; the CLI wires the local pieces together. A hosted adapter implements `RunRepository` and `ExecuteCommand` rather than reaching into `local`.

Tests live in `packages/loopy/_tests_` and cover what's expensive to get wrong: type guarantees, sandbox confinement, durable state transitions and end-to-end CLI behaviour. Skip unit tests for glue.

Invariants worth knowing before you touch the runtime or store:

- A run's graph, input, mode and workspace never change after creation.
- Never replay a command whose outcome is uncertain without an explicit `retryUncertain`.
- Attempt results and their events commit in one transaction, fenced on the owner token.
- Distributed adapters expire leases and mark abandoned attempts uncertain.
- Sandbox execution fails closed.
