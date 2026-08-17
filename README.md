# Loopy

Do the work once. Loopy extracts the reusable process, lets you edit it visually, and runs it again through your locally installed coding agents.

Phase 3 is implemented locally: canonical trace import, deterministic segmentation/features/evidence, bounded proposal repair, persisted extraction review/audit, approval into editable workflow version 1, and offline runtime execution are available. Provider adapters remain local CLI integrations; hosted infrastructure and live-provider calls are out of scope by default.

## Current commands

```sh
bun install
bun run check       # format, lint, typecheck, contracts/runtime/storage/extractor/CLI tests
bun run build       # emit contracts declarations and run the root typecheck
bun packages/cli/src/index.ts --help
```

The extraction path is usable without editing JSON by hand:

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

This probes installation metadata/capabilities only; it does not start a run or make a live network call.

Local schedules and retention cleanup are available without a hosted service:

```sh
bun packages/cli/src/index.ts schedule create --workflow <workflow-id> --cron '0 * * * *' --timezone UTC --project . --json
bun packages/cli/src/index.ts schedule list --project .
bun packages/cli/src/index.ts schedule install <schedule-id> --project . --dir /tmp/loopy-scheduler
bun packages/cli/src/index.ts cleanup preview --project . --max-age-days 30 --json
```

See [the Phase 6 local scheduling and packaging guide](docs/phase6-local-scheduling.md).

## Plan

The canonical implementation plan is tracked at:

- [Loopy Local-First MVP Architecture and Roadmap](.planloft/plans/loopy-local-first-mvp.md)
