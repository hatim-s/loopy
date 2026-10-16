# Working in this repo

Read this before changing code. `bun run check` builds the package and Studio, lints, typechecks and runs the tests. It must pass before a PR. The architecture test enforces layer imports.

## Where code goes

```text
packages/loopy/src/
  core/      shared record types, argv parsing and boundary validation. Pure.
  runtime/   replay engine, journal, retries, store contract and daemon scheduling. Pure.
  sdk/       loopy(), ambient steps, defineCommand and typed shell wrappers.
  local/     SQLite store, registry, bundles, processes, secrets and HTTP server.
  cli/       commands and argument parsing. One file per command in commands/.
apps/studio/src/
  components/  display components
  hooks/       state, polling and requests
packages/loopy/_tests_/   package tests, including shell fixtures
examples/                 canonical loopies and automation helpers
```

The public package entries are `loopy` for the SDK, `loopy/runtime` and `loopy/local`. Studio imports types only from `"loopy"` and uses the local HTTP API for data. It lists loopies and runs and renders step traces and logs.

Layers import downward. Runtime imports core; SDK imports core and runtime; local imports core, runtime and `sdk/host.ts`; CLI imports core, runtime, local and `sdk/host.ts`. Cross-layer imports go through the target layer's `index.ts`, except the explicit SDK host entry. Same-layer imports use file paths. Core and runtime have no Node or Bun dependencies. SDK permits `node:async_hooks` only in `current.ts` to share activation scope with bundled definitions.

## Ownership

- `core/model.ts` defines RunRecord, StepRecord, LogRecord, RunDetail and run statuses.
- `runtime/engine.ts` claims an activation, replays it, persists its outcome and releases ownership.
- `runtime/journal.ts` checks step sequence and keys; `step-runner.ts` owns attempts and terminal writes.
- `runtime/daemon.ts` coordinates schedules, due runs and the concurrency pool.
- `sdk/loopy.ts` validates definitions; `sdk/schema.ts` validates author input.
- `sdk/define-command.ts` and `render-argv.ts` turn typed descriptors into command steps.
- `sdk/shell/` owns command descriptors and parsers.
- `local/store.ts` owns SQLite transactions, fencing and queries; `store-schema.ts` defines the schema and row types; `store-rows.ts` defines queries and maps rows.
- `local/registry.ts` resolves project and global loopies, source ownership and bundle paths.
- `local/bundle.ts` bundles and loads SDK definitions. `local/daemon.ts` prepares bundles and executors for the runtime daemon.
- `local/process.ts` and `spawn.ts` launch and capture processes. `executor.ts` injects declared secrets and redacts results through `secret-redactor.ts`.
- `local/server/routes.ts` exposes read-only loopy, run, trace and log data. `start-server.ts` owns authentication and the loopback server.

Adding a feature: put shared records in core, replay behavior in runtime, author-facing calls in SDK, OS work in local, and commands in `cli/commands/<name>.ts` registered in `cli/index.ts`. Scope flags in `cli/args.ts`. A new store column needs SQL, row conversion and queries; bump the schema version instead of adding a migration. A Studio panel consumes SDK record types and API data. Give each new file one responsibility and a kebab-case name.

## Patterns to follow

Validate untyped data once at its boundary. Reuse `requireRecord`, `requireOneOf`, `validateSlug`, `errorMessage` and the filesystem helpers. Search for existing behavior before adding a helper. Infer types where possible. Use `type` for shapes and `interface` for contracts implemented by classes.

Use braces for every branch and loop. Check failure cases first and return or throw. Keep functions around 40 lines or less and split responsibilities when complexity grows. Errors end with a period and explain what to do next. Comments explain why; avoid em dashes. Casts require a nearby `SAFETY` comment except `as const`. Do not use `any`.

Each CLI command exports `run<Name>(context: CliContext)`, reads positionals through the context helpers and prints through `printJson` or `report`. Do not parse argv inside commands. A command opens its run store through `withRunStore` and closes it on completion.

The replay engine runs user code from the top. Keep code between steps deterministic, preserve sequence and completion order, never nest steps, and fence every durable write with the owner token. Successful steps replay from stored JSON. Recovery may repeat an unfinished effect; it does not promise exactly-once external execution.

Tests belong in `_tests_` directories. Reserve them for durable state transitions, type guarantees, parsers, sandbox confinement, secret handling and CLI behavior. Use temporary homes and fake or recording executors. Run example definitions through `createLoopyRun` and `activateLoopy`. Do not add UI tests or glue tests for reversible edits.

Delete unused paths with their callers and tests. Do not add compatibility aliases or export symbols without a consumer. Preserve user work and keep unrelated automation checkouts untouched.
