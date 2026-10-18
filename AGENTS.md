# Working in this repo

Read this before changing code. `bun run check` builds the package and dashboard, lints, typechecks and runs the tests. It must pass before a push. The architecture test enforces layer imports.

## Where code goes

```text
packages/loopy/src/
  core/       graph, execution identity, records, Store and Executor contracts, validation.
  contract/   browser-safe wire schemas, routes and view derivations.
  engine/     pure graph state machine, reference resolution and retry policy.
  host/       daemon scheduling, activation pool, leases, heartbeat and clock.
  store/      SQLite schema and transactions, event outbox.
  executor/   process sandbox, local execution worker, receipts and bundle protocol.
  sdk/        compile-only graph builder, refs, command descriptors and parsers.
  compiler/   restricted author evaluation, executable bundles and graph revisions.
  local/      home, registry, secrets, service and HTTP server.
  cli/        thin HTTP commands, local compilation and daemon control.
apps/dashboard/src/
  backend/    contract-backed HTTP and event stream adapter.
  routes/     dashboard pages.
  components/ shared display and action components.
  lib/        cache, event reducer and formatting.
```

Tests live under `packages/loopy/_tests_` and `apps/dashboard/_tests_`. The real workflows in `examples/` use the removed step SDK. PR 7 owns their migration; they are outside semantic TypeScript checking until then. Graph example fixtures remain compiled and checked.

The public entries are `loopy` and `loopy/graph` for the builder, `loopy/engine` for the reducer, `loopy/local` and `loopy/contract`. The old runtime entry and executable step SDK are deleted. The dashboard imports only `loopy/contract`.

Layers import downward through their target's index, except the SDK's trusted `host.ts` and `graph-host.ts` entries. Core, engine and contract bundle without host dependencies. Host imports core and engine. Store imports core and the executor PID helper. Executor imports core and contract. Local composes host, store and executor. Compiler imports core, contract, the executor sandbox and the trusted SDK entries. CLI imports the owners it calls. Same-layer imports name the file.

## Ownership

- `core/graph.ts` owns graph nodes, edges and refs; `core/node-run.ts` owns execution keys and node runs. Run ids pin one revision; execution keys include ordered scope tuples.
- `core/executor.ts`, `effects.ts` and `store.ts` own execution results, durable effects and the persistence contract. A failed node stores its error code and message for future rescue handling.
- `engine/state.ts` owns reducer state and input events; `step.ts` owns transitions; `node-run.ts` owns node writes; `resolve.ts` resolves data; `policy.ts` owns backoff, out-schema validation and the inline cap. Transitions separate durable writes from dispatch, wait and finished instructions.
- `host/activate.ts` reconstructs state from persisted node runs, reconciles receipts, calls the reducer, commits durable effects once, then dispatches work. Validation failures do not retry. Retries retain the running lease and persist `nextRetryAt`.
- `host/daemon.ts`, `pool.ts`, `schedules.ts` and `heartbeat.ts` coordinate due work and leases without author callbacks.
- `store/sqlite/` separates events, runs, nodes and schedules. `apply` fences the owner and commits node writes, logs, run outcomes and outbox rows in one transaction. Schema 14 resets old databases. SQLite in memory runs the store contract tests. One store class delegates to per-table functions; `open.ts` owns the schema gate.
- `executor/local.ts` starts a trusted worker. `execution.ts` owns executions, `receipts.ts` owns exclusive started and atomic finished receipt files, and `protocol.ts` decodes stdout results and stderr logs. Finished receipts prevent repeating lost completions. A dead worker with an unfinished receipt fails as uncertain.
- `executor/process.ts`, `spawn.ts` and `sandbox/` own OS processes, bounded capture, process groups and sandbox profiles. Bundles always have restricted filesystem access; mode controls network. Only declared secrets are injected into bundle environments.
- `sdk/graph/` owns compile-only construction. `sdk/shell/` supplies descriptor data and parser implementations, with no executable step path.
- `compiler/restrict.ts` and `ast.ts` enforce builder syntax. `code-module.ts` checks executable imports and exports, `evaluate.ts` imports one restricted snapshot, `bundle.ts` produces executable bundles, and `core/revision.ts` hashes the canonical graph.
- `local/registry.ts` validates compiled graphs and bundles, stores private artifacts and historical graphs, and publishes registry entries. It owns paths and source identity.
- `local/service.ts` owns mutations and wire views. Hook signals return `not_yet` until PR 4c. Snapshots expose node runs; their empty steps and hooks fields keep the existing dashboard compiling until PR 5.
- `contract/` owns the shared wire shapes. Logs retain a per-run sequence for HTTP cursors and use execution key, attempt and index for identity. Schedules use `version` for optimistic concurrency; `revision` names graph hashes.
- `local/server/` owns authenticated HTTP, SSE replay and live transaction delivery. `local/daemon-file.ts` owns daemon discovery.

## Patterns to follow

Validate untyped data once at its boundary. Reuse core validators and filesystem helpers. Infer types where possible. Schemas own wire types. Use interfaces for contracts implemented by classes. Use explicit unions for states, events, effects and outcomes. Avoid casts and `any`.

Use braces for branches and loops. Keep files near 250 lines, with one responsibility each. Comments explain the reason for a choice. Use plain prose without em dashes. Errors explain what failed and what to do next.

Every CLI data command uses the daemon HTTP client. Save compiles locally and transfers graph artifacts. Only daemon control opens SQLite. No command imports author definitions into the daemon.

The reducer accepts time through events and performs no I/O, clock reads or randomness. Persist an execution before dispatch. Fence completions by execution key and attempt and writes by owner token. Never repeat an effect with a started receipt. Reconcile it first.

Tests cover core transitions and durable boundaries. Use temporary homes and injected executors and clocks. Keep server, SSE, schedule and CLI tests passing when contracts change. Remove tests for deleted behavior with their implementation. Do not add compatibility paths or migrations for discarded databases.

PR 4b owns control and value nodes. PR 4c owns waits, sleep, cleanup, rescue and active cancellation. PR 5 owns the dashboard adaptation and the local-to-host rename. Preserve these boundaries and concurrent user work.
