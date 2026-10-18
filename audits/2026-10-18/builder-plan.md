# Loopy v2: graph by construction

Date: 2026-10-18. Base: main c4febc5. Inputs: architecture-redo-proposal.md sections 1 to 6
and the two Astra reviews, graph-proto/report.md, vocabulary-and-architecture.md. This file
is the contract for the PRs that follow. Every brief points here.

## The decision

A loopy is a builder that produces a graph. `run` executes once, at save time, inside an
isolated compiler process, with every SDK call recording a node and returning a typed
reference. Logic lives in code nodes, which are separate modules executed in a sandbox at
run time. The engine is a state machine that walks the stored graph: it never executes
author JavaScript. Replay, the journal, finishOrder, log positions and nondeterminism
checks are deleted.

Why: exact graphs for the dashboard, no user code in the daemon, a coordinator small enough
to host anywhere, and one fewer language (TypeScript control flow) to make deterministic.

## Vocabulary (adds to vocabulary-and-architecture.md)

| Term | Meaning |
| --- | --- |
| graph | the compiled loopy: nodes, edges, refs, schemas, warnings; immutable per revision |
| revision | sha256 of the graph JSON plus every code-node bundle; a run pins one revision |
| node | one unit the engine executes or evaluates; identified by `nodeId` (stable, derived from the builder call order and label) |
| ref | a typed handle to a node's output or a field of it; the only way data moves between nodes |
| predicate | data-only boolean over refs; evaluated by the engine; closed vocabulary |
| code node | a module file exporting `(input) => output` with declared in and out schemas; runs in the executor's sandbox |
| command node | a shell wrapper or `defineCommand` call; runs in the executor as today |
| control node | branch, map, parallel, finally, rescue, fail, wait, agent, subgraph |
| execution | one instance of a node inside a run: `(revision, nodeId, scope)` where scope is the list of `{ nodeId, index }` of enclosing map iterations; attempts are counted per execution |
| node run | the stored record of an execution (replaces StepRecord) |
| workspace | the run's directory; every command and code node runs with it as cwd |

## The SDK (compile-only)

```ts
import { loopy, code, sh, git, branch, map, parallel, wait, finally_, rescue, fail, format, log, now, uuid, eq, gt, size, and, not } from "loopy";

export default loopy("approve-demo", {
  input: { "subject?": "string" },
  run: ({ input }) => {
    const draft = code("draft", { in: { subject: input.get("subject") }, out: { words: "number" }, module: "./draft.ts" });
    log("Draft ready");
    const approval = wait("approve", { timeout: "1h", payload: { approved: "boolean" } });
    const applied = branch(eq(approval.get("approved"), true), {
      yes: () => sh.exec(["bun", "apply.ts", format("{n} words", { n: draft.get("words") })], { label: "apply" }),
      no: () => fail("Rejected"),
    });
    return { draft, applied };
  },
});
```

Rules enforced by the validator (one AST pass over the loopy file and its author modules):
- `run` is synchronous and contains only SDK calls, refs, `ref.get(...)`, literals, object
  and array literals of those, and arrow functions passed to control nodes.
- No `await`, `if`, loops, `try`, template literals with refs, calls to anything that is not
  an SDK export or a subgraph defined with `subgraph()`, no captured mutable bindings.
- Keys and labels are string literals.
- Code node `module` is a relative path to a file that default-exports one function.
- `defineCommand` descriptors are data; their `parse` functions are code nodes in disguise
  and are bundled and executed in the sandbox like code modules.

Node vocabulary, v1:
- `code(label, { in, out, module, retry?, timeout? })` → Ref<out>
- command wrappers (`sh.exec`, `git.*`, `fs.*`, `text.*`, `net.*`, `defineCommand` results)
  → Ref<parsed output>; inputs are literals or refs; argv items may be refs
- `branch(predicate, { yes, no })` and `switch_(ref, { [literal]: () => ... , default })` →
  Ref<union of arm results>
- `map(ref<T[]>, (item: Ref<T>, index: Ref<number>) => ..., { concurrency?, onError: "fail" | "collect" })` → Ref<R[]>
- `parallel({ a: () => ..., b: () => ... })` → Ref<{ a, b }>
- `wait(label, { timeout?, payload })` → Ref<payload> (the renamed hook)
- `finally_(body, cleanup)`: cleanup runs after body succeeds, fails or is cancelled; body's
  outcome is preserved; cleanup failure is recorded and the body outcome still wins
- `rescue(body, (error: Ref<{ message, code }>) => ...)`: runs the handler when body fails
  after its retries are exhausted; result is the union
- `fail(message)`: terminal failure of the run
- `format(template, { name: ref | literal })`: the one value-producing node; scalar refs only
- `log(message, data?)`, `now()`, `uuid()`, `random()`: nodes; values persisted per execution
- `subgraph(label, (args) => ...)`: a reusable builder function; expanded at compile time
  with a scope prefix; not a runtime construct
- predicates: `eq ne lt lte gt gte exists isNull in_ size and or not`; `size` only inside a
  comparison; operands are refs or literals of the same declared type
- `agent(...)`: deferred to a later slice; it is `code` to dispatch plus `wait` to receive

What is gone from the SDK: `step(fn)` with an inline function, ambient `log` inside steps,
`race`, `sleep` as a step (it becomes `sleep(duration)`, a node that parks the run; same as
before but a node).

## Engine semantics (what replay gave for free, now written down)

- Scheduling: a run is a cursor over the graph. The engine evaluates control nodes itself;
  it dispatches code and command executions to the executor and parks the run; a
  completion writes the node run and wakes the run. Parallel and map schedule children up
  to concurrency; the run has at most one pending frontier set per scope.
- Identity: node runs are keyed by `(runId, nodeId, scopePath)`; attempt is a column; a
  retry is a new attempt of the same execution.
- Retry: per node `{ attempts, backoff }` with the same defaults as today (3, exponential
  from 1 s capped at 60 s); command nonzero exit retries only when declared, as today; code
  node exceptions retry; validation of out schema does not retry.
- Uncertain completion: the executor reports a receipt `{ executionKey, attempt }` before
  the effect and the result after; a lost result is reconciled by re-asking the executor
  for that key before re-executing (local executor: a file under the workspace scratch).
- map: ordered results; `onError: "fail"` stops scheduling new items, lets running items
  finish, then fails the map; `"collect"` records per-item outcomes and continues. Fan-out
  cap 1000 items, concurrency default 4.
- parallel: all branches run; the node fails when any branch fails after the others settle.
- Cancellation: marks the run cancelled, stops scheduling, fences late completions by
  attempt, runs pending `finally_` cleanups, then finishes.
- Limits: inline output 1 MiB per execution, beyond that the execution fails with a clear
  message (artifact references are a later slice); logs 64 KiB per attempt.
- Time and randomness: `now`, `uuid`, `random` are nodes whose value is persisted on first
  execution.
- Logs: command and code executions capture stdout/stderr per attempt; `log` nodes write a
  log row; identity is `(executionKey, attempt, index)`.
- Leases, fencing, heartbeat, hooks table (now `waits`), schedules with revision, the
  outbox: unchanged in semantics.

## Code node contract

`module` default-exports `async (input: In, context) => Out`. The executor runs it as
`bun <bundle> ` with JSON input on stdin and JSON output on stdout, in the workspace, under
the same sandbox profile commands use (`mode` on the loopy decides network and write
scope), with the declared secrets in env. The module's imports are bundled at save time
into one file per code node (Bun.build, the existing import.meta plugin). `context` has
`log(message, data)` (captured into the attempt's logs) and `workspace`.

## Target layout

```
packages/loopy/src/
  core/        model: Graph, Node, Edge, Ref, Predicate, NodeRun, RunRecord, events; validation
  sdk/         builder only: loopy(), nodes, predicates, subgraph, typed refs, defineCommand descriptors + shell namespaces (descriptors stay, parse functions become code modules)
  compiler/    save-time: isolated evaluation of the loopy file, validator, code-node bundling, revision hash, registry entry
  engine/      coordinator: graph walker, scheduler (due runs, cron), semantics above, Store and Executor interfaces, Clock
  store/       SQLite implementation of Store (schema 12: node_runs keyed by execution, waits, graphs), outbox, memory store for tests
  executor/    local process executor for command and code executions, sandbox launchers, receipts
  server/      routes from the contract, SSE and poll routes, static dashboard
  service/     the mutation and view owner
  contract/    wire schemas: GraphView, NodeRunView, RunView (with graph overlay data), routes
  cli/         thin commands over the service (and the compiler for save)
apps/dashboard  pages as today plus the graph view with overlay
```

Deleted: `runtime/` (activation, journal, replay, step-runner, logger positions,
concurrency, hook, rate-limit stays but moves to engine), `sdk/ambient.ts`, `sdk/run.ts`,
`local/bundle.ts` (replaced by compiler), `cli/inline-run.ts` (the CLI starts a daemon on
demand instead). The server, service, store, outbox, contract and dashboard are adapted,
not rewritten.

## Slices

Horizontal
- H1 core model and contract: Graph, Node kinds, Ref, Predicate, execution identity,
  NodeRun, GraphView; validation helpers.
- H2 SDK builder: compile-only SDK producing a Graph; typed refs; predicates; subgraph;
  the shell namespaces as command nodes; unit tests that compile every example.
- H3 compiler and save: isolated compiler process, validator with diagnostics, code-node
  bundling, revision, registry entry with the graph; `loopy save`, `loopy graph`.
- H4 engine: coordinator over Store and Executor with the semantics above; store schema 12;
  local executor for code and command executions with receipts; delete runtime/.
- H5 service, server, contract, dashboard adaptation: node runs with scope on the wire,
  GraphView on LoopyView, inbox on waits, run page timeline from node runs.
- H6 graph view: dashboard renders GraphView with the run overlay.
- H7 migration and cutover: rewrite the examples and the twenty real loopies, docs, CLI
  text, delete the old paths, version 0.5.0.

Vertical (what Hatim can run)
- V1 straight line: save a loopy of commands and one code node, print its graph, run it on
  the new engine, see node runs in `loopy inspect`. Needs H1, H2, H3, H4 (sequence, code,
  command nodes only).
- V2 control: branch, switch, map, parallel, format, now/uuid, fail. Needs H4 control
  semantics and H2 nodes.
- V3 people and time: wait, sleep, finally_, rescue, cancellation. Needs H4 and the waits
  table.
- V4 dashboard: graph view with live overlay, inbox on waits, run page. Needs H5, H6.
- V5 cutover: all real loopies migrated and running from the daemon; old code deleted.

PR plan
| PR | Slice | Writer | Review |
| --- | --- | --- | --- |
| 1 | H1 | Sol | Sol |
| 2 | H2 | Sol | Sol |
| 3 | H3 | Sol | Sol |
| 4a | H4 sequence, code and command executions, receipts, store schema 12 | Sol | Sol, then Opus quality pass on 1 to 4a |
| 4b | H4 branch, switch, map, parallel, format, values | Sol | Sol |
| 4c | H4 wait, sleep, finally_, rescue, cancellation | Sol | Sol |
| 5 | H5 | Sol | Sol |
| 6 | H6 graph view | Opus | Sol |
| 7 | H7 migration and cutover | Sol | Sol, then Opus quality pass on everything |

PRs 1 to 3 are sequential but small. 4a to 4c are sequential. 5 can start after 4a. 6
after 5. 7 after 4c and 5. Each PR builds on a worktree branched from main, is reviewed by
Sol until mergeable, merged locally with `--no-ff`, and the worktree removed.

## Rules for every PR (unchanged from the previous milestones)

Tests only in `_tests_`; no backwards compatibility (schema bumps reset runs.sqlite; the
old SDK is deleted, not deprecated); parse once at the edge; schemas own types; no casts;
one owner per concern; delete the old path in the same PR; functions under about 40 lines;
comments say why; `bun run check` green before every push; Hatim's attribution lines; local
`--no-ff` merge. Sol briefs carry the file layout and patterns for the slice explicitly.

## Decisions made in PR 1 (H1), binding for later slices

- Node ids: zero-based builder call order plus label or kind, implicit joins included. The
  canonical approve-demo graph is `_tests_/fixtures/graphs.ts`; PR 2's builder must
  reproduce it exactly.
- `input` is the reserved ref for the loopy's input; scope bindings cannot shadow it, node
  outputs or other bindings. `ref` is a reserved key in value objects; nested refs allowed.
- A scope's result lives in its join node; a scoped join returning to its enclosing map is
  the one permitted back edge. Rescue errors are visible only inside the handler. Ref
  visibility requires graph reachability (earlier sibling or ancestor).
- Predicates: `left/right` for comparisons, `value` for exists/isNull/size, `predicates` for
  and/or, `predicate` for not; `in` checks literal-array element types; `size` accepts
  string or array refs; a missing declared field is `unresolved_ref`.
- Retry record: required `attempts`, exponential `backoff`, `retryOnExit`. Command nodes:
  `key`, value dictionaries for flags and env, nullable cwd and stdin, parser hash non-null
  when a parser exists.
- ExecutionKey string: run id, node id and ordered scope tuples as JSON segments joined by
  `/`. Terminal node runs carry `endedAt`; retrying carries error and end time; indefinite
  waits use `wakeAt: null`.
- Wire: code modules expose `{ name }` only; NodeRunView equals NodeRun. `RecordSpec`
  supports `json`. `Duration` is owned by core. The SQLite `bundle_hash` column stays until
  the schema bump in PR 4a, behind `RunRecord.revision`.

## Decisions for the open questions raised by the architecture page (2026-10-18)

1. CLI transport: the CLI is an HTTP client of the daemon for every command except `save`
   (which compiles locally, then POSTs the graph and code bundles to the daemon) and the
   `daemon` commands. The CLI starts the daemon on demand and never opens SQLite.
2. `data_version` polling goes away in PR 5 once the daemon is the only writer; the
   in-process subscriber is the sole feed for SSE and the poll route reads by cursor.
3. `local/` becomes `host/`: home paths, secrets, config, daemon.json, daemon composition,
   service install, typegen. `store/` and `executor/` are split out of it as the layout says.
4. From `runtime/`: activation, journal, replay, step-runner, logger, concurrency, hook,
   hook-state, context, engine.ts and run-detail are deleted; daemon, pool, cron,
   heartbeat, retry and rate-limit move to `engine/`; store.ts, memory-store and
   event-outbox move to `store/`.
5. Node ids are call order plus label or kind (PR 1). Inserting a node shifts later ids and
   produces a new revision; runs pin a revision; the overlay never crosses revisions.
6. Order is explicit: `next` edges carry sequence, refs carry data. Edge kinds are PR 1's
   list: next, yes, no, case, each, join, cleanup, rescue.
7. `input` is a `Ref<Input>`; fields are read with `input.get("subject")`. The example is
   corrected above.
8. A code node's `in` is a map of Values; its TypeScript type is inferred from the refs and
   literals; `out` is the declared schema. "Declared in" means the inferred map type.
9. Command wrappers keep their signatures; a label is given with `options.label`; the
   default label is null and the id falls back to the descriptor key.
10. Wait resolution: `POST /runs/:id/waits/:label` for the dashboard, `POST /waits/:token`
    for external callers; the payload is validated against the declared schema; a repeat
    with an identical payload is a 200 no-op, a different payload is a 409. The
    prepare-then-dispatch split belongs to the agent slice.
11. The engine owns the run while executions are in flight (status running); the run is
    parked (suspended, lease released) only for wait and sleep. Completions are fenced by
    (executionKey, attempt): a stale attempt's completion is ignored.
12. Every node gets a node run, control nodes included: branch stores `{ arm }`, switch
    `{ case }`, map the collected results, join the scope result. Not-taken versus
    not-reached follows from that.
13. Event kinds: entity `node` with NodeRun statuses as kinds; entity `wait` with created,
    resolved, expired (replaces hook).
14. Run status: running while executions are in flight, suspended while parked, as today.
15. `finally_` returns a Ref to the body's result.
16. A retrying node run carries `nextRetryAt`; the run's wakeAt is the minimum over its
    pending node runs.
17. Cancellation sends SIGTERM to in-flight executor processes, SIGKILL after 5 s, then
    runs pending cleanups.
18. `map` with `onError: "collect"` returns an array of `{ ok: true, value } | { ok: false,
    error: { message, code } }` in input order.
19. The schedules table's integer concurrency field is renamed `version`; `revision` means
    the graph hash everywhere. A scheduled fire pins the loopy's current revision.
20. The JSON poll route `GET /events?after&epoch` ships in PR 5. Remote receipts belong to
    the cloud slice.

## Decisions made in PR 2 (H2, `loopy/graph` SDK)

- Command nodes keep `argv` for the program and positional operands, `flags` for named values (literals or refs), and `flagSpec` for the descriptor's rendering data (style, attached or equals form, boolean omitted when false). Direct `sh` commands have no `flagSpec`. The executor renders the final argv at run time once refs are resolved; there are no hidden format nodes.
- Platform variants of a descriptor resolve on the build host; the resolved rendering data is what the graph records.
- A descriptor with a parser uses a relative literal module path, `parse: "./parse.ts"`, default-exporting `(raw: { stdout, stderr, exitCode }, input) => Out`. PR 3 bundles and hashes that module through the code-module path and records `parse: { bundleHash, input }`; a descriptor without one records `parse: null`. Built-in parser paths are package-relative and resolved at compile time. Inline parser functions and closure extraction are removed.
- Each subgraph invocation gets its own label namespace, so a labelled node may expand more than once. Prefixes are joined with `/`.
- Map bodies bind `${owner}:item` and `${owner}:index`; rescue bodies bind `${owner}:error`.
- `switch_` defaults are a `case` edge labelled `"default"`; `parallel` arms are labelled `case` edges.
- `sh` is callable as in the plan and also exposes `.exec` and `.run`. `fs.ls.raw` keeps its own `ls` descriptor.
- `log` and `sleep` return `Ref<null>`; `fail` returns `Ref<never>`.
- Deferred to PR 3: compiler isolation, AST restrictions, literal enforcement, module path checks, code and parser bundling with hashes, revision generation, save integration.

## Decisions made in PR 2 fix rounds

- 1. Every branch, switch, parallel, map, rescue and finally records its own result join before the enclosing sequence continues.
- 3. Parallel results are records keyed by arm label, with each field resolving through that arm's result join.
- 4. Core owns ERROR_FIELDS with message and code strings and JSON data; rescue bindings and SDK refs use that shared spec.
- 5. OutSchema is a discriminated record or value schema used by code, commands and parsers, with built-in parser outputs declared precisely.
- 7. Ref paths project declared object keys only; arrays and scalars expose no get operation, and core rejects paths into them as unresolved_ref.

- Join results are `{ kind: "value"; value: Value } | { kind: "none" }`; non-returning scopes record `none`, core resolves it as `never`, and only author references to a never result produce `unresolved_ref`.
- Labels, arm keys and record field names cannot be `__proto__`, `constructor` or `prototype`; the builder throws a reserved-label error, core emits `reserved_name`, and arm dictionaries use `Object.fromEntries` over own entries.
- A parallel is non-returning if any arm is definitely non-returning; the builder records a `none` join, core resolves it as `never`, author references report `unresolved_ref`, and a surrounding rescue resolves through its returning handler.


## Decisions made in PR 3 (H3)

- `compile` returns an explicit `ok` union; compiler diagnostic codes live in core, use one-based file positions, and preserve structured graph-builder errors across the subprocess boundary.
- Evaluation imports one bundled snapshot of the restricted author modules; PR 2's eager `loopy()` performs the builder call during that import, and the compiler pins `loopy/graph` imports to its own SDK.
- Builder imports use named, unaliased SDK exports and named relative author exports; namespace imports, re-exports, cyclic imports and SDK aliases are rejected, while erased TypeScript declarations remain allowed.
- Builder and control callbacks are synchronous arrows; static identifier property names count as literal keys, while computed keys, spreads, mutation, JavaScript control flow, runtime TypeScript enums and namespaces, and non-JSON literals are rejected.
- Custom parsers are module-level literal `defineCommand` descriptors with a literal key or literal namespace and name and a relative literal `parse` module path. Parsers default-export one function and cannot reuse another parser's key or a built-in command key.
- Code-module paths become absolute paths resolved from the author module that declares the node; graph revisions therefore include that source location, and GraphView continues to expose only the module basename.
- Core command parsers now carry `parse: { bundleHash, input }`, where `input` is the prepared value dictionary before argv flattening; refs in that dictionary use normal visibility checks, and GraphView exposes the dictionary while hiding the hash. PR 4a must resolve it and send `{ result, input }` on parser stdin.
- Code node and parser wire protocol for PR 4a: every bundle is executable ESM with a default function export. Code stdin is one JSON object containing the resolved input dictionary, `{ [name: string]: Json }`; the function receives `(input, { workspace: process.cwd(), log })`. Parser stdin is `{ "result": { "stdout": string, "stderr": string, "exitCode": number }, "input": { [name: string]: Json } }`; the function receives `(result, input)`. Stdout ends with one JSON result line, `JSON.stringify(output ?? null) + "\n"`, written by the runner after the author function returns. The runner inserts a newline before the result to separate any unterminated author output. PR 4a parses the last stdout line as the result and attaches every preceding byte to the attempt log as `stdout`. Each stderr log line is `{ "message": string, "data": Json }` followed by `"\n"`; omitted data is `null`. `context.log` and console methods `log`, `info`, `debug`, `warn`, `error`, `trace`, `table` and `dir` all use these stderr JSON lines. PR 4a owns sandbox launch, receipts, retries and output validation.
- The compiler uses sandbox-exec on macOS and bubblewrap on Linux, denies network and writes outside cwd, clears inherited environment and secrets, limits evaluation to ten seconds and captured output to 16 MiB, and fails closed when the platform sandbox is unavailable; Bun uses `--smol` because this Bun CLI exposes no hard heap-cap option.
- CLI save transfers base64 bundle bytes through authenticated `PUT /api/loopies/:slug`; the service verifies graph semantics, exact node-order coverage, hashes and revision before atomically storing bundles under `home/bundles` and historical graphs under `home/graphs`, then publishes registry metadata. Artifact files are private and have no download route; the request-body cap is 64 MiB.
- Registry entries use format version 2; stale entries are ignored and overwritten on save, current malformed entries still surface errors, and there is no whole-loopy bundle field or compatibility loader.
- `loopy(name, options)` accepts description, schedule, secrets, mode, scope, input and run. Core and contract define one graph `meta` record; save reads author metadata from that record. The defaults are resolved once by the SDK. Identical validated saves return the existing entry with its savedAt and leave entries and artifacts unchanged.
- CLI data commands, secrets and command-help generation use the daemon HTTP client; list and schedule requests carry caller workspace, daemon startup is serialized, and inline execution and the redundant `--detach` flag are removed.
- The old runtime interface retains the `bundleHashFor` callback name until PR 4a, but the host supplies graph revisions; the host rejects graph execution until PR 4a and never imports author definitions.
- Retired whole-bundle, inline-run and bundled-daemon tests are replaced by compiler, artifact, HTTP-save and CLI tests; the remaining HTTP runtime fixtures construct runs directly through the existing runtime test helpers.
- The four graph-example sketches now have deterministic sibling module fixtures and compile without diagnostics; the four real workflows in `examples/` still use the old SDK and require the H7 migration, so PR 3 does not claim they compile or execute as v2 graphs.

- Round 1: executable modules and every transitive local import reject non-literal `import()` and `require()` with `dynamic_import`. SDK options unwrap TypeScript wrappers and require inline object literals. Callback parameters reject computed keys, defaults and rest. SDK call paths are derived from the runtime export record. Core owns canonical revision input and hashing.
