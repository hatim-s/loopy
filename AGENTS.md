# Working in this repo

Read this before changing code. `bun run check` builds the package and dashboard, lints, typechecks and runs the tests. It must pass before a push. The architecture test enforces layer imports.

## Where code goes

```text
packages/core/src/       graph contracts, validation and pure engine/ reducer.
packages/contract/src/   browser-safe wire schemas, routes and views.
packages/sdk/src/        compile-only graph builder, descriptors and parsers.
packages/runtime/src/    os/, host/, store/, executor/, service/ and local/ adapters.
packages/compiler/src/   restricted author evaluation and artifact compilation.
packages/cli/src/        HTTP commands and daemon control.
packages/loopy/src/      thin public re-exports and executable entrypoint.
packages/loopy/_tests_/  product integration tests, fixtures and opt-in acceptance/.
apps/dashboard/src/     contract-backed backend, routes, components and display helpers.
apps/cloud/src/         Worker, workspace DOs, SQL/R2 adapters and receipt authority.
apps/cloud/dev/         local stack, journeys, failure probes and workload comparisons.
apps/cloud/_tests_/dev/ tests for development tooling.
apps/sandbox/src/       attempt admission, supervision, export guards and Docker workers.
scripts/                repository build and global-install orchestration only.
```

The real workflows in `examples/` use the removed step SDK. PR 7 owns their migration; they are outside semantic TypeScript checking until then. Graph example fixtures remain compiled and checked.

The public entries are `loopy` and `loopy/graph` for the builder, `loopy/engine` for the reducer, `loopy/local` and `loopy/contract`. The old runtime entry and executable step SDK are deleted. The dashboard imports only `@loopy/contract` from the implementation packages.

Within each package, imports are relative and extensionless without `/index`. Across packages, use explicit `@loopy/*` exports declared in workspace dependencies. Production source must never reach another package through a relative source path or import the public `loopy` distribution. White-box integration tests and diagnostic tools under `apps/cloud/dev` may reach implementation files directly. These internal paths are not public package APIs.

Core has no workspace dependencies. Contract and SDK depend on core. Runtime depends on core, contract and SDK. Compiler depends on runtime and SDK as well as core and contract. CLI composes those owners. The public distribution re-exports supported APIs and starts the CLI; it owns no business logic. The build vendors private implementation modules and declarations into the published tarball and rewrites private specifiers so installation needs no unpublished packages.

Inside runtime, host depends on core and engine, service on core and contract, store and executor on core, contract and os/, and os/ on core only. Os owns processes, sandbox profiles, secret files and durable files and is exported to apps as `@loopy/runtime/os`. Local composes these modules. Runtime layers use their target's public barrel. SDK host and graph-host are explicit trusted exports. Author definitions import `loopy` or `loopy/graph`; private package names are not supported author imports. Architecture tests enforce package exports, declared dependencies, the package DAG, runtime layer imports and browser portability.

Ownership paths below are relative to their named package source. The runtime sections use the os/host/store/executor/service/local subdirectory names; engine lives under core/src/engine.

## Ownership

- `core/graph/` owns graph nodes, edges, refs, execution keys and node runs. Run ids pin one revision; execution keys include ordered scope tuples.
- `core/executor.ts`, `effects.ts` and `store.ts` own execution results, durable effects and the persistence contract. A failed node stores its error code and message for future rescue handling.
- `engine/state.ts` owns reducer state, input events and `nextDeadline`, the time a run must step again; `step.ts` owns transitions; `traversal.ts` and `control.ts` evaluate lexical sequences and scoped controls; `effects.ts` adds dispatch and entropy requests; `resolve.ts` resolves scoped data; `retry.ts` owns backoff; `output.ts` validates out schemas and the inline cap.
- `host/turn.ts` reconstructs state from persisted node runs, calls the reducer, commits durable effects once and admits dispatches; local `host/activation/` and `host/durable/` both use it. `host/lease.ts` owns claim and bounded release. Local activation dispatches work after each committed turn. Each dispatched execution reconciles its receipt before starting new work. Validation failures do not retry. Retries retain the running lease and persist `nextRetryAt`.
- `host/durable/` owns bounded activation turns and provider reconciliation. The reducer keeps a run leased while a node waits to retry, and rate admission follows persistence. Provider calls stay outside store transactions.
- `host/daemon.ts`, `pool.ts`, `schedules.ts` and `heartbeat.ts` coordinate due work and leases without author callbacks.
- `store/` separates events, runs, nodes, waits, rate limits, schedules, durable turns and `query/` dashboard reads. `apply` fences the owner and commits node writes, attempts, scope summaries, log usage, wait registration, suspension, run outcomes and outbox rows in one transaction. `SqlRunStore` is a facade over table modules that take one connection context, with every effect kind handled in `apply.ts`. `schema/fresh.ts` owns the fresh schema and its only version marker, `meta.schema_version`. Local homes upgrade schema 13 and 14 without dropping records or changing the epoch and reject unsupported populated schemas without resetting them. Stores read time from Effect's Clock. Tests use the same store on in-memory SQLite.
- `core/executor.ts` owns the execution spec. Command specs carry resolved settings and every platform variant; the executing host renders argv for its own platform. `attemptBudgetMs` is the one outer deadline for the local worker and sandbox admission.
- `executor/local.ts` starts a trusted worker with one `worker-protocol.ts` request. `execution.ts` owns executions, `receipts.ts` owns exclusive started and atomic finished receipt files, and `protocol.ts` decodes stdout results and stderr logs and interprets command exits for both the local executor and the sandbox worker. Finished receipts prevent repeating lost completions. Execute waits for a started attempt on receipt file events. A dead worker with an unfinished receipt fails as uncertain.
- `os/fs.ts` owns durable files: exclusive writes, atomic replace, exclusive link publication, directory sync, bounded reads, process liveness and pid locks.
- `os/process.ts`, `spawn.ts` and `sandbox/` own OS processes, bounded capture, process groups and sandbox profiles. `sandbox/tool.ts` resolves the one sandbox tool that commands, bundles and the compiler use. Bundles always have restricted filesystem access; mode controls network. Only declared secrets are injected into bundle environments.
- `sdk/graph/` owns compile-only construction. `sdk/shell/` supplies descriptor data and parser implementations, with no executable step path.
- `compiler/restrict.ts` and `ast.ts` enforce builder syntax. `module.ts` checks code exports, `evaluate.ts` imports one restricted snapshot, `bundle.ts` produces executable bundles, and `core/revision.ts` hashes the canonical graph and bundles.
- `local/save-compiled.ts` validates and stores private bundles and historical graphs before publishing registry metadata. `local/registry.ts` owns paths and source identity.
- `service/` owns mutations, queries, schedules, definition summaries and wire views over injected stores and registries. Hook signals validate and resolve durable waits atomically. Snapshots expose node runs and hook history. Cancellation rejects unfinished executions and started graphs with finally cleanup until host cancellation can drive that cleanup. `local/service.ts` composes filesystem registry, secrets and type generation with this portable service.
- `contract/` owns the shared wire shapes. Logs retain a per-run sequence for HTTP cursors and use execution key, attempt and index for identity. Schedules use `version` for optimistic concurrency; `revision` names graph hashes.
- `local/server/` owns authenticated HTTP, SSE replay and live transaction delivery. `local/daemon/file.ts` owns daemon discovery.
- `apps/cloud/src/` composes portable service and durable host with workspace SQL and R2 artifacts. Receipt authority owns session epochs, attempt records and export exclusion in a separate DO; verified immutable results live in R2. See the app README for bindings and local-only configuration.
- `apps/sandbox/src/` composes authority, result storage, backend and artifact reader dependencies after acquiring its process lock. Admission persists before Docker work. Monitoring reconciles started attempts without repeating them. Export guards remain until owned-helper removal is confirmed. The default factory selects filesystem authority; the architecture playground passes a custom factory for DO authority.

## Patterns to follow

Validate untyped data once at its boundary. Reuse core validators and filesystem helpers. Infer types where possible. Schemas own wire types. Use interfaces for contracts implemented by classes. Use explicit unions for states, events, effects and outcomes. Avoid casts and `any`.

Use braces for branches and loops. Keep files near 250 lines, with one responsibility each. Comments explain the reason for a choice. Use plain prose without em dashes. Errors explain what failed and what to do next.

Every CLI data command uses the daemon HTTP client. Save compiles locally and transfers graph artifacts. Only daemon control opens SQLite. No command imports author definitions into the daemon.

The reducer accepts time through events and performs no I/O, clock reads or randomness. Persist an execution before dispatch. Fence completions by execution key and attempt and writes by owner token. Never repeat an effect with a started receipt. Reconcile it first.

Do not add compatibility paths or migrations for discarded databases. Retained filesystem receipt compatibility and its exit condition belong to the [sandbox README](apps/sandbox/README.md#retained-data). Cloud summary repair and its exit condition belong to the [cloud README](apps/cloud/README.md#retained-data). The legacy local SQLite upgrade and its exit condition belong to the [runtime README](packages/runtime/README.md#retained-data). See the cloud README for the phase 2 approval boundary.

## Tests and isolation

The test gate includes `packages/loopy/_tests_`, `apps/dashboard/_tests_` and `apps/cloud/_tests_`. Shared test fixtures stay under their owning test root. Tests cover core transitions and durable boundaries. Use temporary homes and injected executors and clocks. Keep server, SSE, schedule and CLI tests passing when contracts change. Remove tests for deleted behavior with their implementation.

Tests that need repository-local state use `packages/loopy/_tests_/fixtures/quality-test-root.ts`. It creates a unique child of `.loopy/quality-tests` with its own `.loopy/loopies` project marker, preventing ancestor registry selection. Older suites still use temporary directories or `.loopy/architecture-tests`; the helper has not replaced every allocator.

For verification runs, inject fixture Loopy homes and sanitize child environments to prevent personal-state access. Give fixture projects explicit registry markers. Do not set global `TMPDIR` for legacy sandbox tests. Use isolated state and port 0 for ephemeral Bun/Miniflare servers. Dispose owned processes before removing only that fixture's state. Keep historical evidence separate from disposable test output.

PR 4b owns control and value nodes. PR 4c owns waits, sleep, cleanup, rescue and active cancellation. PR 5 owns the dashboard adaptation and the local-to-host rename. Preserve these boundaries and concurrent user work.
