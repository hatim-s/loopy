# Contributing

Bun 1.4 or newer. Run `bun install`, then `bun run check` before pushing. It builds, lints, typechecks and runs the tests. Read [AGENTS.md](AGENTS.md) for code ownership and conventions.

Six private workspace packages own core, contracts, SDK, runtime, compiler and CLI. The thin public distribution, `packages/loopy`, exposes `loopy` for the compile-only graph builder, `loopy/engine` for the reducer, `loopy/local` for local daemon, service and store composition and `loopy/contract` for wire schemas. The dashboard views saved loopies, runs, node executions and logs. Author definitions in TypeScript.

Core, engine, contract (with its sandbox and server entries), service, host and the portable store entry stay portable. The portable typecheck, browser-bundle test and architecture test enforce these boundaries. The SDK imports core and builds graph data without executing author work. Service owns mutations, schedules and views over injected stores and registries. Local composes service, host, store, executor and os with registry paths. Os owns subprocesses, sandbox profiles, secret files and durable files. Cloud composes the same service and durable host with workspace SQL/R2 adapters and a sandbox provider. See the [cloud](apps/cloud/README.md) and [sandbox](apps/sandbox/README.md) READMEs for receipt authority modes.

Follow [AGENTS.md](AGENTS.md#tests-and-isolation) for test roots, fixture isolation and teardown. Cloud development tools live in `apps/cloud/dev` and the dashboard demo script in `apps/dashboard/dev`. Root `scripts/` contains only build and global-install commands. Run `bun run acceptance:local` after a core or runtime refactor and `bun run acceptance:package` after changing distribution or resource paths.

Host and store invariants:

- A run pins its input, workspace and graph revision. Execution keys include ordered scopes.
- Persist execution before dispatch. Reconstruct from node runs and reconcile receipts before acting.
- Fence run writes by owner token, completions by execution key and attempt, and sandbox authority writes by session.
- Never repeat a started effect after a crash. Reconcile its original worker; an unresolved outcome fails uncertain. External side effects still need idempotency.
- Store and verify immutable result bytes before publishing the terminal pointer. Preserve terminal results. Release export guards only after helper cleanup is confirmed.
- Logs use execution key, attempt and index for identity and a per-run sequence for HTTP cursors.
- Native SQLite schema 16 upgrades retained 13, 14 and 15 homes without dropping records or changing the epoch. Other populated unsupported schemas fail closed and must be preserved for migration. Do not recreate tables as an upgrade strategy.
- Sandbox execution fails closed.

See the [sandbox README](apps/sandbox/README.md#retained-data) for retained receipt compatibility and the [cloud README](apps/cloud/README.md#retained-data) for summary repair. The cloud README also defines the phase 2 approval boundary.
