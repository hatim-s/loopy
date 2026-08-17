# Loopy

**The local graph harness for coding agents.**

Do the work once. Loopy captures the trace, extracts an editable execution graph, and runs it again through Codex, Claude Code, OpenCode, or Pi on your machine.

Loopy is infrastructure for graph engineering: agent loops do open-ended work inside nodes, while explicit edges, deterministic control nodes, durable state, approvals, budgets, and recovery govern how the whole system runs. The graph is an executable, versioned contract—not merely a diagram.

## What Loopy does

- Captures or imports coding-agent sessions as canonical traces.
- Extracts evidence-backed execution graphs from successful work.
- Lets you inspect and edit nodes, edges, policies, and provider choices visually.
- Runs graphs locally with branching, parallel joins, retries, approvals, pause, resume, cancellation, replay, and checkpoint forks.
- Keeps operational state in local SQLite and exports portable canonical JSONL.
- Integrates with locally installed Codex, Claude Code, OpenCode, and Pi CLIs through explicit capability contracts.

Loopy does not provide hosted agent compute. Your source, credentials, subprocesses, traces, and graph state remain local by default.

## Terminology

Loopy uses **graph harness** as its product category and **graph engineering** for the discipline it enables. An **execution graph** is the user-facing artifact. `WorkflowDefinition`, `/workflows`, and related CLI terms remain compatibility names in the current contracts. A **loop** is the bounded reasoning-and-tool-use cycle that may run inside an agent node.

Read the [graph engineering position and terminology](docs/graph-engineering.md).

## Current commands

```sh
bun install
bun run check       # format, lint, typecheck, contracts/runtime/storage/extractor/CLI tests
bun run build       # emit contracts declarations and run the root typecheck
bun packages/cli/src/index.ts --help
```

The trace-to-graph path is usable without editing JSON by hand:

```sh
bun packages/cli/src/index.ts import fixtures/sessions/successful.json --provider codex --project .
bun packages/cli/src/index.ts extract --import <import-id> --project .
bun packages/cli/src/index.ts review list --project .
bun packages/cli/src/index.ts review show <proposal-or-job-id> --project .
bun packages/cli/src/index.ts approve <proposal-or-job-id> --project .
```

The deterministic extractor never contacts a provider. An explicit, read-only installed-provider probe is available only with opt-in:

```sh
bun packages/cli/src/index.ts validate-provider --provider codex --opt-in --json
```

This probes installation metadata and capabilities only; it does not start a graph run or make a live network call.

Local schedules and retention cleanup are available without a hosted service:

```sh
bun packages/cli/src/index.ts schedule create --workflow <workflow-id> --cron '0 * * * *' --timezone UTC --project . --json
bun packages/cli/src/index.ts schedule list --project .
bun packages/cli/src/index.ts schedule install <schedule-id> --project . --dir /tmp/loopy-scheduler
bun packages/cli/src/index.ts cleanup preview --project . --max-age-days 30 --json
```

See [the local scheduling and packaging guide](docs/phase6-local-scheduling.md).

## Architecture and roadmap

- [Loopy Local-First Graph Harness Architecture and Roadmap](.planloft/plans/loopy-local-first-mvp.md)
