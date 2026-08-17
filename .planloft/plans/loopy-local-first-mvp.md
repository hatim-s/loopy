---
title: Loopy Local-First Graph Harness Architecture and Roadmap
slug: loopy-local-first-mvp
kind: plan
status: active
theme: detailed
---

# Loopy Local-First Graph Harness Architecture and Roadmap

Build Loopy as a local graph harness that turns completed coding-agent work into an editable execution graph, then validates, runs, records, and debugs that graph without a hosted service.

## Context

Loopy starts from a simple product contract:

> Do the work once with Codex, Claude Code, OpenCode, or Pi. Loopy captures what happened, extracts the reusable execution graph, lets the user edit it visually, and runs it again locally.

### Product terminology

Loopy's product category is **local graph harness for coding agents**. The discipline it enables is **graph engineering**: making agent work an explicit topology of nodes, edges, state transitions, validation gates, approvals, and recovery paths.

An agent still runs an internal reasoning and tool-use loop inside an agent node. The execution graph governs how those loops coordinate with deterministic verification, routing, joins, transforms, and human decisions. The graph is the versioned executable contract; the Studio canvas is one view of it. `WorkflowDefinition`, `/workflows`, and related CLI names remain compatibility terms until a deliberate contract version changes them.

This use of graph engineering concerns task and execution topology. It does not mean knowledge graphs, GraphRAG, graph databases, or graph neural networks.

The MVP is not a generic cloud workflow platform. It is a local developer tool with four responsibilities:

1. Capture or import an agent session as a normalized trace.
2. Extract an evidence-backed workflow proposal from that trace.
3. Execute the approved workflow through locally installed coding agents.
4. Visualize, pause, resume, retry, replay, fork, and edit the workflow and its runs.

Everything operational stays on the user's machine: source code, prompts, traces, artifacts, state, provider credentials, and agent subprocesses. Cloud deployment, accounts, team collaboration, hosted execution, billing, and enterprise governance are explicitly deferred. If Loopy later needs a cloud architecture, it may be rewritten around the proven local contracts rather than forcing speculative distributed-systems abstractions into the MVP.

### Product boundary

The MVP must support:

- Codex, Claude Code, OpenCode, and Pi through separate provider adapters.
- Forward capture of runs started through Loopy.
- Import of historical sessions where a provider exposes a supported export, hook, SDK, or machine-readable interface.
- An editable directed graph with branching and parallel joins.
- Agent nodes plus deterministic control nodes for verification, approval, routing, and joining.
- Crash-safe local run state.
- Graceful pause between nodes, cancellation of an active node, and explicit resume behavior.
- Playback of stored events without executing tools.
- Retry of one failed node and fork of a run from a checkpoint.
- Trace-to-graph extraction with trace-event evidence for every inferred node.

The MVP does not include:

- Hosted agent compute or hosted trace storage.
- A marketplace, plugin store, or multi-tenant control plane.
- Enterprise SSO, RBAC, audit retention, or data residency controls.
- A universal OS sandbox.
- Arbitrary business automation outside coding-agent sessions.
- Claims that generated workflows or model outputs are deterministic.
- Model-selection optimization without observed evaluation data.
- TypeScript or shell code generation as the primary execution mechanism.

## Approach

### Architectural position

Loopy should interpret a versioned workflow definition through a small local state machine. It should not generate one large shell script and treat that script as the runtime. Branch readiness, parallel joins, attempts, approvals, pause state, retries, and crash recovery require persistent orchestration state even when every work node ultimately launches a CLI process.

The architecture has six layers:

```text
Provider CLIs / SDKs / exports
             |
             v
    Provider adapter layer
             |
             v
 Canonical events and sessions ----> Extraction engine
             |                            |
             v                            v
      SQLite local store <-------- Workflow proposal
             |                            |
             v                            v
       Runtime state machine ------> Versioned workflow
             |                            |
             +------------+---------------+
                          v
              Local API and React Studio
```

The provider layer owns incompatibility. The runtime consumes one canonical contract and refuses to silently emulate provider capabilities that do not exist.

### Primary implementation decisions

| Decision | Choice | Reason |
|---|---|---|
| Runtime | Bun and strict TypeScript | One language across CLI, runtime, extraction, local server, contracts, and UI tooling. |
| Workflow execution | Interpreted, versioned execution plan | Easier pause, resume, migration, inspection, and testing than generated shell or TypeScript. |
| Operational storage | SQLite through `bun:sqlite`, WAL mode | Transactions, indexed queries, recovery, concurrent readers, and one local writer. |
| Trace interchange | Deterministic JSONL export | Human-inspectable, streamable, portable, and easy to attach to bug reports. |
| Contract validation | Zod 4 plus emitted JSON Schema | Runtime validation, TypeScript inference, and provider-independent structured-output schemas from one source. |
| Local API | Hono on Bun, bound only to `127.0.0.1` | Small typed HTTP surface with straightforward Bun deployment. |
| Live updates | Server-Sent Events | Runs are predominantly server-to-UI event streams; commands remain ordinary authenticated POST requests. |
| UI | React, Vite, TanStack Router, TanStack Query | Typed routes, cached server state, mature local web application tooling. |
| Graph canvas | `@xyflow/react` | Node/edge editing, selection, handles, minimap, viewport controls, and custom node rendering. |
| Client editing state | Zustand with Immer | Small transient graph/editor state; server state remains in TanStack Query. |
| Styling | Tailwind CSS plus CSS variables | Fast application UI work with deliberate light/dark tokens. |
| Unit/integration tests | Vitest | Consistent TypeScript tests across packages and React components. |
| Browser tests | Playwright | End-to-end tests for extraction review, graph editing, and run controls. |
| Formatting/linting | Biome | One fast formatter and linter for the monorepo. |
| Packaging | Bun workspaces; no Turborepo initially | The first repository is small enough to avoid another orchestration layer. |
| Desktop shell | Browser opened by `loopy ui`; no Electron/Tauri | Avoid packaging and update complexity until the local web product works. |

Use current stable versions when scaffolding and pin them in `bun.lock`. Do not encode loose `latest` ranges in committed package manifests.

### Why SQLite, not JSONL, for live traces

Use `.loopy/loopy.db` as the canonical live store. Use JSONL as an export generated from committed database events.

SQLite is the better operational format because Loopy needs to answer and atomically update questions such as:

- Which nodes are ready now?
- Which attempts are running, paused, blocked, or complete?
- Have all incoming branches reached a join?
- Which approval is pending?
- What was the last committed event sequence before a crash?
- Which provider sessions, artifacts, and workflow versions belong to this run?
- What changed between two attempts or two workflow versions?

Pure JSONL makes those queries projection work that Loopy would have to rebuild, synchronize, lock, and recover itself. SQLite already supplies transactions, indexes, migrations, uniqueness constraints, and crash recovery.

JSONL remains important as a boundary format:

- `loopy trace export <run-id>` writes events in sequence order.
- `loopy trace import <file>` validates and imports a compatible trace.
- Raw provider streams may be preserved as artifacts when useful.
- Exported JSONL contains normalized Loopy events, not an undocumented dump of arbitrary internal objects.

Do not dual-write every live event to SQLite and JSONL. SQLite is the source of truth. Generate JSONL deterministically on request or when a run is archived. This avoids disagreement after a partial write.

Enable WAL mode, foreign keys, a busy timeout, and explicit schema migrations. Use one runtime writer per project, guarded by a project lock. The Studio and read-only CLI commands may use separate read connections.

## Repository structure

Create the project at `/Users/admin/Projects/loopy` with this initial layout:

```text
loopy/
  apps/
    studio/                    # React visual editor and trace debugger
  packages/
    cli/                       # `loopy` command and command handlers
    contracts/                 # Zod schemas, TS types, JSON Schema emission
    runtime/                   # scheduler, state machine, attempts, joins
    storage/                   # SQLite schema, migrations, repositories
    tracing/                   # normalized events, exporters, redaction
    extractor/                 # trace segmentation and workflow proposal
    providers/                 # adapter interface and four implementations
    local-api/                 # Hono routes, SSE, auth, static Studio serving
    workspace/                 # git worktrees, snapshots, diff/artifact capture
    testing/                   # fake provider and conformance harness
  fixtures/
    sessions/                  # sanitized provider import fixtures
    workflows/                 # valid and invalid contract fixtures
  docs/
    architecture.md
    contracts.md
    provider-capabilities.md
    trace-format.md
  package.json
  tsconfig.base.json
  biome.json
  bunfig.toml
  bun.lock
```

Keep the user-facing project data separate from the Loopy source repository:

```text
<user-project>/
  loopy.json                   # project-level defaults and policy
  loopy/
    workflows/
      <workflow-id>/
        workflow.json          # canonical editable workflow definition
        prompts/
        skills/
        fixtures/
  .loopy/
    loopy.db                   # local operational state; ignored by Git
    lock                       # single active scheduler ownership
    artifacts/
      <sha256>/...
    exports/
      <run-id>.events.jsonl
    logs/
```

Workflow definitions, prompts, skills, and fixtures are source-controlled. Runs, imported sessions, transient logs, the SQLite database, and generated exports are ignored by default.

## Loopy contracts

Place every cross-package contract in `packages/contracts`. Every persisted structure includes a `schemaVersion`; user-authored workflows also include a monotonically increasing `workflowVersion` and stable UUIDs for nodes and edges.

### Workflow definition

`WorkflowDefinition` contains:

- identity: `id`, `name`, `description`, `schemaVersion`, `workflowVersion`
- inputs: named, typed runtime inputs with defaults and secret markers
- nodes: stable node definitions
- edges: explicit source, target, optional route, and condition
- defaults: provider, model, reasoning level, timeout, retry policy
- policies: tools, workspace, network, approval, budget, concurrency
- triggers: manual in the core MVP; local scheduling after runtime stability
- metadata: creation source, extraction ID, timestamps, tags

The initial visible node kinds are:

| Node kind | Responsibility |
|---|---|
| `agent` | Run one provider session or turn with a prompt, skills, inputs, and compiled policy. |
| `verify` | Run deterministic commands or inspect artifacts and emit pass/fail evidence. |
| `approval` | Stop scheduling downstream work until the user approves, rejects, or edits. |
| `route` | Select an outgoing edge from structured data. |
| `join` | Wait for configured upstream branches and combine their completion envelopes. |
| `transform` | Perform a small deterministic data mapping without spending an agent turn. |

“Every step is an agent” remains a useful authoring shorthand, but control flow and verification must not be hidden inside prompts. The UI can visually distinguish agent work from runtime control primitives.

### Node completion envelope

Every node attempt produces a validated `NodeCompletion`:

```ts
type NodeCompletion = {
  status: "succeeded" | "failed" | "cancelled" | "skipped";
  route?: string;
  summary: string;
  outputs: Record<string, unknown>;
  artifacts: ArtifactRef[];
  verification: VerificationResult[];
  providerSession?: ProviderSessionRef;
  usage?: UsageRecord;
  warnings: ContractWarning[];
};
```

The agent may reason freely inside a node. The handoff is structured so the runtime can route, join, verify, display, and retry without parsing prose.

### Canonical trace event

Every stored event has:

- `id`: globally unique event ID
- `runId`, optional `nodeId`, optional `attemptId`
- `sequence`: strictly increasing integer scoped to a run
- `occurredAt`: wall-clock timestamp
- `monotonicOffsetMs`: ordering/duration aid within the process
- `type`: discriminant
- `payload`: schema-validated event body
- `provider`: optional provider provenance
- `parentEventId`: optional causal parent
- `redaction`: whether fields were removed or summarized

Initial event families:

- run lifecycle: created, started, pause-requested, paused, resumed, cancelling, completed
- node lifecycle: ready, started, output, blocked, completed
- attempt lifecycle: created, retrying, failed, cancelled
- provider lifecycle: probed, session-started, message, usage, session-ended
- tools: requested, started, completed, denied
- workspace: snapshot-created, file-change-summary, diff-created
- artifacts: recorded, rejected-by-limit
- verification: started, result
- approval: requested, resolved
- extraction: imported, segmented, proposal-created, proposal-approved
- runtime diagnostics: warning, capability-degraded, recovery

Do not persist hidden chain-of-thought. Persist user-visible messages, tool activity, structured outputs, usage, errors, and runtime decisions.

### Compiled execution plan

Compilation converts `WorkflowDefinition` into `ExecutionPlan`:

1. Validate graph shape, IDs, cycles, joins, and reachable terminal nodes.
2. Resolve defaults into every node.
3. Bind provider adapter and installed provider version.
4. Compile prompt, skills, runtime inputs, and completion schema.
5. Compile provider-specific permissions and policy flags.
6. Compare required capabilities with the adapter capability report.
7. Fail on required unsupported behavior; warn on explicitly optional degradation.
8. Hash the normalized plan and record the hash on every run.

The execution plan is reproducible. Agent output is not deterministic.

## Provider adapter layer

Define one `ProviderAdapter` interface rather than forcing identical CLI flags:

```ts
interface ProviderAdapter {
  readonly id: "codex" | "claude" | "opencode" | "pi";
  probe(): Promise<ProviderInstallation>;
  capabilities(): Promise<ProviderCapabilities>;
  listSessions?(query: SessionQuery): AsyncIterable<SessionSummary>;
  importSession?(ref: SessionRef): Promise<ImportedSession>;
  start(request: ProviderRunRequest): AsyncIterable<ProviderEvent>;
  resume?(request: ProviderResumeRequest): AsyncIterable<ProviderEvent>;
  cancel(handle: ProviderProcessHandle): Promise<void>;
}
```

The capability matrix is a contract, not documentation alone:

- structured streaming events
- historical session export/import
- session resume
- session fork
- explicit model selection
- explicit reasoning level
- tool allowlist
- writable path policy
- network policy
- maximum turns
- token or monetary budget
- timeout/cancellation
- usage reporting
- nested subagent visibility
- provider-native sandbox mode

Implement all four adapters in the first product slice, but allow capability differences. A provider that cannot enforce a required policy causes compilation to fail with an actionable message; Loopy must not silently pretend the policy exists.

### Trace capture modes

Loopy captures sessions in two ways.

#### Forward capture

`loopy run` launches the provider through its supported programmatic surface and normalizes machine-readable output while the process runs. This is the reliable path and must be implemented first.

Capture:

- prompts and visible provider messages
- tool requests and results exposed by the provider
- subprocess stdout/stderr with size limits
- provider session and parent/subagent identifiers when available
- usage and model metadata when exposed
- workspace baseline and final diff summary
- verification commands and results
- runtime policy, routing, retry, approval, and recovery decisions

#### Historical import

`loopy sessions` and `loopy import` use provider-supported exports, SDKs, or hooks. Raw internal transcript files may be supported only behind a versioned, explicitly unstable importer with fixtures for known provider versions.

Every imported event records:

- original provider
- original session identifier
- importer version
- provider version when known
- source format
- lossiness warnings
- stable source locator when it is safe to retain

Never promise identical fidelity across providers. The UI must show the capability and lossiness report before extraction.

## Runtime

### State machine

Run states:

- `created`
- `running`
- `pause_requested`
- `paused`
- `cancelling`
- `cancelled`
- `succeeded`
- `failed`

Node attempt states:

- `pending`
- `ready`
- `running`
- `blocked_approval`
- `succeeded`
- `failed`
- `cancelled`
- `skipped`

Persist every state transition and its event in one SQLite transaction. The scheduler computes ready nodes from committed predecessor attempts and edge conditions. A join becomes ready only after its declared join policy is satisfied.

### Pause, stop, resume, replay, retry, and fork

These terms must have precise product semantics:

- **Pause**: stop scheduling new nodes. The active provider process may finish its current node. Once no active node remains, the run becomes `paused`.
- **Stop current node**: cancel the provider subprocess. The attempt becomes cancelled or failed based on the adapter result.
- **Resume**: continue scheduling from committed state. An interrupted node is retried or provider-resumed only through an explicit user choice.
- **Replay**: render stored events and artifacts without executing any provider or tool.
- **Retry node**: create a new attempt for one node using the recorded inputs and current workflow version unless the user chooses edited inputs.
- **Fork run**: create a new run from a checkpoint, preserving upstream outputs while allowing provider, model, prompt, policy, or downstream graph changes.

MVP pause is a safe boundary pause, not OS-level suspension of an arbitrary CLI process. The UI must not label subprocess cancellation as pause.

### Crash recovery

On startup, the runtime:

1. Acquires the project lock.
2. Opens SQLite and applies idempotent migrations.
3. Finds attempts left in `running` without a live owned process.
4. Records a recovery event and marks them `interrupted` through the failed/cancelled envelope.
5. Leaves the run paused for user inspection unless the workflow explicitly allows automatic retry of that node.
6. Recomputes ready nodes only after recovery transactions commit.

Do not automatically repeat nodes with external side effects after a crash.

### Workspace and artifacts

For Git repositories, default mutating workflows to a temporary Git worktree under `.loopy/workspaces/<run-id>`. Record the baseline commit, branch, dirty-state warning, final status, and diff artifact. Never discard a user's pre-existing working-tree changes.

Store artifacts by SHA-256 with a manifest containing media type, size, producer node, relative source path, and redaction state. Enforce per-artifact and per-run size limits. Do not copy the whole repository into the artifact store.

## Extraction layer

Extraction is a compiler assisted by a local coding agent, not a single prompt that produces an unquestioned graph.

### Inputs

`ExtractionRequest` contains:

- imported canonical session and capability/lossiness report
- user-stated goal or selected successful outcome
- repository identity and baseline/final Git metadata when available
- observed commands, tests, and verification outcomes
- selected extraction provider/model
- user preferences such as cost sensitivity and allowed tools

### Pipeline

1. **Normalize:** convert provider events to canonical events and group subagent activity.
2. **Segment:** divide the session into goal episodes, tool clusters, failures, recoveries, and verification phases.
3. **Classify:** distinguish reusable intent, environment discovery, accidental detours, one-off fixes, and side effects.
4. **Infer inputs:** replace concrete versions, paths, issue IDs, branches, and similar values with typed variables.
5. **Draft graph:** propose nodes, edges, joins, route conditions, prompts, skills, and provider defaults.
6. **Derive verification:** prefer commands and checks that actually demonstrated success in the source session.
7. **Infer policy:** suggest tools, writable roots, network access, approval gates, budgets, and timeouts from observed behavior.
8. **Attach evidence:** every proposed node and policy points to the trace event IDs that justify it.
9. **Validate:** run the proposal through the same workflow compiler used at execution time.
10. **Repair:** allow a bounded structured repair pass for schema or graph errors.
11. **Review:** show the trace and proposed workflow side by side; nothing becomes runnable until the user approves it.
12. **Persist:** save the accepted workflow as version 1 and retain the proposal plus user edits for provenance.

### Extraction proposal contract

Each proposal includes:

- workflow draft
- inferred inputs with examples and confidence
- per-node evidence event IDs
- removed detours and why they were removed
- uncertainty and provider-data loss warnings
- proposed verification strategy
- proposed permissions and approvals
- expected side effects
- unresolved questions that block safe execution

The extractor may suggest a simpler workflow than the original session. It must never claim that inferred steps are proven merely because they appeared once.

## Local API and Studio

### Local API

`loopy ui` starts one local API/server process and opens the Studio in the browser.

Security requirements:

- bind only to `127.0.0.1` by default
- use a random high port unless configured
- create a short-lived random session token and place it in the opened URL fragment or bootstrap exchange
- require the token on mutation requests and SSE connections
- validate `Origin` and reject cross-site requests
- never expose provider credentials through API responses
- never capture environment variables wholesale

Primary endpoints:

- `/api/providers`
- `/api/sessions`
- `/api/imports`
- `/api/extractions`
- `/api/workflows`
- `/api/workflow-versions`
- `/api/runs`
- `/api/runs/:runId/events`
- `/api/runs/:runId/commands`
- `/api/artifacts/:artifactId`
- `/api/stream` for SSE

Mutations accept contract-validated commands such as `WorkflowPatch`, `PauseRun`, `ResumeRun`, `RetryNode`, and `ForkRun`. The React application does not write workflow JSON or SQLite directly.

### Studio routes

- `/` — recent workflows, imports, and runs
- `/sessions` — provider sessions and import fidelity
- `/extract/:importId` — trace-to-graph review
- `/workflows/:workflowId` — workflow overview and versions
- `/workflows/:workflowId/edit` — graph editor
- `/runs/:runId` — live graph, timeline, logs, artifacts, and controls
- `/runs/:runId/replay` — playback without execution
- `/providers` — installation and capability diagnostics
- `/settings` — local paths, retention, redaction, and defaults

### Essential Studio views

#### Extraction review

Use a split view:

- left: original session timeline with search, tool filters, and subagent grouping
- center: proposed workflow graph
- right: selected node contract, evidence links, inferred inputs, permissions, and verification

Selecting a node highlights the source trace events. The user can accept, edit, merge, split, or remove nodes before saving.

#### Workflow editor

Use React Flow for nodes and edges. Persist edits as atomic patches validated by the local server. Include:

- drag/drop and connect/disconnect
- node configuration drawer
- branch labels and join policy
- validation markers
- auto-layout through ELK.js
- undo/redo over client-side patch history
- version save with change summary
- capability warnings per provider

#### Run debugger

Synchronize three views:

- execution graph with node/attempt status
- ordered event timeline
- detail panel for messages, tools, artifacts, verification, usage, and errors

Controls include graceful pause, cancel active node, resume, retry, fork, and playback. Destructive or side-effectful retries require explicit confirmation.

## CLI surface

Implement the CLI in this order:

```text
loopy init
loopy doctor
loopy providers list
loopy providers inspect <provider>
loopy sessions list [--provider]
loopy sessions import <session-ref>
loopy extract <import-id>
loopy validate <workflow>
loopy run <workflow> [--input key=value]
loopy pause <run-id>
loopy resume <run-id>
loopy cancel <run-id>
loopy retry <run-id> --node <node-id>
loopy fork <run-id> --from <node-id>
loopy replay <run-id>
loopy trace export <run-id> [--out file]
loopy trace import <file>
loopy ui
```

Exit codes and machine-readable `--json` output are part of the CLI contract. Interactive prompts must have non-interactive flag equivalents before the command is used by scheduling or other agents.

## Local safety model

Prompt instructions are guidance, not isolation. Compile policy through every provider's native permission controls where available, and expose the result before execution.

MVP safety layers:

1. Explicit workflow policy and tool allowlist.
2. Provider-native permission/sandbox flags.
3. Git worktree isolation for repository mutations.
4. Explicit writable roots and working directory.
5. Approval nodes before configured side effects.
6. Runtime timeouts, cancellation, retry limits, and concurrency limits.
7. No implicit environment-variable capture.
8. Trace and artifact redaction plus size limits.

When a provider cannot enforce a required filesystem or network restriction, compilation fails. When the restriction is advisory, the UI labels it advisory. Do not market local execution as universally sandboxed.

## Steps

### Phase 0 — Repository and contracts

1. Scaffold the Bun workspace and package boundaries under `/Users/admin/Projects/loopy`.
2. Add strict TypeScript, Biome, Vitest, package exports, and a single root command surface.
3. Implement versioned Zod contracts for workflows, nodes, edges, events, completion envelopes, provider capabilities, extraction proposals, and commands.
4. Emit JSON Schema fixtures and add compatibility tests that fail on unplanned breaking changes.
5. Implement graph validation: stable IDs, reachability, terminal nodes, route labels, join shape, and cycle rejection for MVP.

**Exit evidence:** valid fixtures parse; invalid fixtures fail with paths; JSON Schema snapshots are reviewed; `bun test` is green.

### Phase 1 — Storage and fake runtime

1. Implement `packages/storage` with `bun:sqlite`, WAL, migrations, repositories, and project locking.
2. Create tables for workflow versions, imports, extraction jobs, runs, node attempts, events, approvals, artifacts, and provider installations.
3. Implement transactional event append plus state projection updates.
4. Build the runtime scheduler against a deterministic fake provider.
5. Add linear workflows, branching, joins, verification, approval blocking, graceful pause, resume, cancel, retry, and crash recovery.
6. Add deterministic JSONL trace export and re-import tests.

**Exit evidence:** kill the runtime mid-node, restart it, and recover without duplicating a completed node or side effect; parallel join tests pass; exported traces round-trip.

### Phase 2 — Provider adapters and capture

1. Build the adapter conformance harness in `packages/testing`.
2. Implement `probe`, capability reporting, start, event normalization, cancellation, and session provenance for all four providers.
3. Add supported historical import mechanisms provider by provider.
4. Store sanitized, version-labelled fixture sessions for regression tests.
5. Record capability degradation instead of normalizing it away.
6. Add provider CLI version checks to `loopy doctor`.

**Exit evidence:** the same two-node fixture workflow runs through Codex, Claude Code, OpenCode, and Pi; each produces a canonical trace and honest capability report.

### Phase 3 — Extraction MVP

1. Implement trace segmentation and deterministic feature extraction before invoking an agent.
2. Define the extraction prompt and strict `ExtractionProposal` response schema.
3. Attach evidence event IDs to nodes, variables, verification, and policies.
4. Add bounded schema-repair and compile-validation passes.
5. Implement CLI review output and save an approved proposal as workflow version 1.
6. Create golden extraction fixtures from successful, failed-then-recovered, and subagent-heavy sessions.

**Exit evidence:** an imported real session produces a valid editable execution graph; every proposed node links back to evidence; the accepted graph can execute through the fake provider and one real provider.

### Phase 4 — Local API and Studio debugger

1. Implement Hono routes, local token bootstrap, origin checks, and SSE.
2. Build the React shell with TanStack Router and Query.
3. Implement provider/session lists and extraction review.
4. Implement the live run graph, event timeline, details, artifacts, and pause/cancel/resume controls.
5. Implement replay, retry, and fork flows.
6. Add Playwright coverage for live updates and recovery after browser refresh.

**Exit evidence:** a user can import, extract, approve, run, pause, resume, inspect failure evidence, retry, and replay without editing JSON or using the terminal after launching `loopy ui`.

### Phase 5 — Visual workflow authoring

1. Add React Flow editing and custom node renderers.
2. Implement server-validated `WorkflowPatch` operations.
3. Add undo/redo, auto-layout, graph diagnostics, and version saving.
4. Add forms for inputs, prompts, skills, providers, policies, verification, routing, and joins.
5. Add visual diffs between workflow versions.

**Exit evidence:** the user can change provider/model, insert or remove a node, add a branch/join, edit verification, save a new workflow version, and run it successfully.

### Phase 6 — Local scheduling and packaging

1. Add a scheduler contract with manual and cron-expression triggers.
2. Implement per-workflow overlap policy: skip, queue, or cancel previous.
3. Implement missed-run policy: skip or run once; defer catch-up fan-out.
4. Export launchd on macOS and systemd timer/cron fallback on Linux. Add Windows Task Scheduler only after a Windows test environment exists.
5. Package the CLI as an npm package with platform checks and `loopy doctor` guidance.
6. Add retention and cleanup commands for local runs and artifacts.

**Exit evidence:** a scheduled workflow launches through the same runtime and database, respects overlap policy, and appears in Studio with a complete trace.

## Testing and release gates

### Contract tests

- schema snapshots and compatibility fixtures
- workflow patch validation
- event sequence and causal references
- provider capability compilation
- JSONL export/import round trips

### Runtime tests

- table-driven state transitions
- randomized DAG readiness tests
- parallel join timing permutations
- pause requests during different node states
- cancellation races
- crash recovery after every transaction boundary
- retry idempotency and side-effect approval
- lock contention between CLI and Studio

### Provider conformance tests

- probe and version detection
- structured event normalization
- stdout/stderr truncation
- cancellation behavior
- session resume when supported
- lossiness declaration for imports
- tool and permission compilation

Tests that require an installed provider or paid subscription are opt-in and labelled separately from deterministic local CI.

### UI tests

- extraction evidence linking
- graph patch validation and rollback
- event-stream reconnect using the last sequence ID
- run control confirmations
- browser refresh during a live run
- light, dark, and system theme behavior
- keyboard navigation and focus on graph-adjacent controls

### MVP acceptance scenario

The release candidate must demonstrate this end-to-end scenario:

1. Complete a small repository task with one supported agent.
2. Import or forward-capture the session.
3. Extract a workflow and inspect evidence for its nodes.
4. Remove one exploratory detour and parameterize one concrete input.
5. Save workflow version 1.
6. Run it locally through a different supported provider.
7. Pause between nodes and resume.
8. Fail verification, inspect the failure, and retry the failed node.
9. Replay the completed run without executing tools.
10. Export the normalized trace to JSONL and re-import it.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Provider CLIs change output formats. | Prefer supported SDK/export/event interfaces, version adapters, retain sanitized fixtures, and fail probes clearly. |
| Historical imports are lossy or unstable. | Show an import fidelity report and prioritize forward capture. |
| Extraction reproduces accidental detours. | Segment first, require evidence, show removed steps, and require human approval. |
| An extracted graph repeats a destructive action. | Infer side effects, require approval nodes, default retries off for side-effectful nodes, and use worktrees. |
| Pause semantics mislead users. | Define pause as boundary pause and expose cancellation separately. |
| SQLite has multiple writers. | Use a project lock, one scheduler writer, WAL, busy timeout, and transactional commands. |
| Artifacts or traces consume excessive disk. | Hash/deduplicate artifacts, set size/retention limits, and provide cleanup diagnostics. |
| Local web UI is attacked from another webpage. | Loopback bind, random token, origin checks, authenticated SSE and mutations, no permissive CORS. |
| “Four providers” creates lowest-common-denominator design. | Keep one adapter interface plus explicit capabilities; compile provider-specific policy instead of erasing differences. |
| Runtime becomes coupled to UI. | Keep contracts and runtime headless; Studio uses the same local command API as CLI automation. |
| Code generation becomes a second runtime. | Interpret the canonical plan in MVP; treat future exporters as adapters, not sources of truth. |

## Open questions

These decisions should be resolved with implementation evidence, not architecture speculation:

1. Whether Pi integration is more stable through its SDK or RPC mode for the first adapter.
2. Whether Codex historical import has a supported stable export sufficient for extraction, or should initially be forward-capture only.
3. Whether active provider output can be resumed after cancellation or must always create a new attempt.
4. Whether the extractor should default to the source provider or a user-selected preferred extraction provider.
5. Which artifact types deserve first-class rendering beyond text, JSON, diffs, and images.
6. Whether workflow cycles are needed after real user evidence; the MVP should reject cycles and model bounded retry explicitly.
7. Whether a Tauri shell adds enough value after the browser-based Studio is stable.

## References

- [Bun SQLite API](https://bun.sh/docs/runtime/sqlite)
- [Zod JSON Schema support](https://zod.dev/json-schema)
- [TanStack Router](https://tanstack.com/router/latest/docs/overview)
- [React Flow](https://reactflow.dev/)
- [Hono on Bun](https://hono.dev/docs/getting-started/bun)
- [Vite](https://vite.dev/guide/)
- [Playwright](https://playwright.dev/docs/intro)
