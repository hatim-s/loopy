---
title: Architecture repeat workload profile
status: prepared, root launch gate closed
date: 2026-10-23
starting-head: 6ffecdfd60e16aaa335467684d918b3cd8b44813
---

# Selection and ownership

Set `LOOPY_PLAYGROUND_PROFILE=architecture` on every harness command. An unset variable retains the legacy profile. Empty strings, `default`, misspellings and every other explicit value fail parsing before config or state access. Sanitized supervisor, Worker, dashboard and daemon child environments carry the selected profile explicitly.

This lane changed only `scripts/playground/**`, `scripts/daemon-playground/**` and these architecture notes. It launched no stack, service or workload, created no commits, and did not read old private config files. Existing `.loopy/cloud`, `.loopy/playground` and `.loopy/playground-daemon` remain outside this lane's reads and writes. Test files use disposable temporary directories and injected HTTP responses.

# Selected configuration

| Setting | Architecture | Unset variable |
| --- | --- | --- |
| Cloud state | `.loopy/playground-architecture` | `.loopy/playground` |
| Sandbox worktree | Cloud state plus `/runtime-root` | Same relative layout |
| Sandbox state | Sandbox worktree plus `/.loopy/cloud/sandbox` | Same relative layout |
| Frozen fixture repository | Cloud state plus `/loopies-playground` | Same relative layout |
| Daemon state | `.loopy/playground-daemon-architecture` | `.loopy/playground-daemon` |
| Daemon upstream | Architecture frozen fixture repository | Legacy frozen fixture repository |
| Evidence directory | `.notes/cloud/evidence/architecture` | `.notes/cloud/evidence` |
| API / sandbox / dashboard / inspector | `15270 / 15271 / 15272 / 15273` | `15070 / 15071 / 15072 / 15073` |
| Daemon port | `15370` | `15170` |
| Receipt mode | `durable-object`, required explicitly | `filesystem`, parsed default |

All capture filenames retain their meaning inside the selected evidence directory. Journals, artifacts, logs, locks, private configs, runtime queue captures and registry files follow the selected state root. Architecture captures cannot select legacy filenames through a hardcoded historical directory. `start` and `serve` probe all five architecture ports before launching children. The daemon checks its own port again on every start. No availability check was performed against these reserved ports in this lane; root must run the checks at launch time.

Private `config.json` uses the existing batch, API/dashboard, workspace, token, otherToken, sandboxToken, concurrency and creation fields. Architecture requires `receiptMode: "durable-object"` and an additional `receiptsToken`. The four credential values must be distinct. Generated private files use mode `0600`; directories use `0700`. Existing default-profile config files parse without a mode field. A newly generated default config records `receiptMode: "filesystem"`.

The generated Worker configuration preserves root-owned bindings and requires these architecture bindings before any child starts:

- `SANDBOX_RECEIPTS`, class `SandboxReceipts`.
- `RECEIPT_RESULTS`, R2 bucket binding.

Generated Worker vars set `RECEIPTS_NAMESPACE=playground-architecture`, `RECEIPTS_ROOT=<absolute architecture sandbox state>`, `SANDBOX_URL=http://127.0.0.1:15271` and `CONCURRENCY=4`. Private `worker.dev.vars` adds `RECEIPTS_TOKEN` from `receiptsToken`, separate from `SANDBOX_TOKEN` and both `LOCAL_AUTH` principals. No token enters evidence or the executable bundle environment through this change.

# Receipt composition

Architecture starts Worker first. A bounded readiness loop accepts only `/health` returning `service: "loopy-cloud", stage: "local"`, with a one-second request deadline and a fifteen-second overall retry window. A dead owned Worker fails readiness. The sandbox starts after readiness succeeds. Failed startup and shutdown drain the children this supervisor launched. Legacy keeps its sandbox-first ordering.

`startSandbox(config, factory)` invokes the dependency factory after acquiring the OS root lock. The architecture factory rejects populated filesystem `receipts` and `exports` directories before constructing the HTTP authority. This also rejects unresolved filesystem export guards. There is no import, fallback or persistent mode marker.

The factory constructs `new HttpSandboxAuthority({ url: profile.api, token: settings.receiptsToken, namespace: profile.batchPrefix })` and returns:

```ts
{
  authority,
  resultsFor: (workspace) => authority.resultsFor(workspace),
  backend: boundedBackend(docker, 4),
  artifactReader: new DockerArtifacts(providerConfig),
}
```

The client sends `POST /internal/sandbox-receipts`, a dedicated bearer credential and `X-Loopy-Receipts-Namespace`. Its per-request deadline is five seconds. The filesystem profile uses `filesystemDependencies(providerConfig, { backend })`. Both preserve the existing bounded backend and Docker root labels. Sandbox root validation remains `<worktree>/.loopy/cloud/sandbox`; no production path check was loosened.

# Root-only startup and load commands

These commands were prepared and were not executed by this lane. Root owns launch, the first baseline, preflights, arming and workload admission. Root must finish cloud binding/export integration and its review gates first.

```sh
export LOOPY_PLAYGROUND_PROFILE=architecture
bun --no-env-file scripts/playground/index.ts start
bun --no-env-file scripts/playground/index.ts status
bun --no-env-file scripts/playground/index.ts prepare
bun --no-env-file scripts/playground/metrics.ts baseline 90 2
bun --no-env-file scripts/playground/index.ts preflight --group a
bun --no-env-file scripts/playground/index.ts preflight --group b
bun --no-env-file scripts/playground/index.ts preflight --group c
bun --no-env-file scripts/playground/index.ts arm --baseline .notes/cloud/evidence/architecture/playground-performance-baseline.json
```

`prepare` freezes the same 15 fixture sources into the new repository and publishes them. No fixture file changed. `arm` requires the current source batch, three successful one-run preflight receipts, and a nonempty baseline sample receipt from the selected evidence directory with the same batch. No gate file was written by this lane.

Run the three primary cohorts through their existing independent group leads or terminals after root opens the gate:

```sh
LOOPY_PLAYGROUND_PROFILE=architecture bun --no-env-file scripts/playground/index.ts cohort --group a
LOOPY_PLAYGROUND_PROFILE=architecture bun --no-env-file scripts/playground/index.ts cohort --group b
LOOPY_PLAYGROUND_PROFILE=architecture bun --no-env-file scripts/playground/index.ts cohort --group c
```

Standard speed is unchanged. Group counts are 200, 200 and 125. Three separate preflights plus 525 primary runs yield 528 retained IDs. The primary expectation remains 461 successes, 64 controlled failures and 125 approvals. Four global API slots, four runtime slots, batch locks, pressure/ABORT guards, admission journals and input distribution are unchanged.

Daemon commands, also root-only:

```sh
LOOPY_PLAYGROUND_PROFILE=architecture bun --no-env-file scripts/daemon-playground/prepare.ts
LOOPY_PLAYGROUND_PROFILE=architecture bun --no-env-file scripts/daemon-playground/run.ts --root-load-gate
LOOPY_PLAYGROUND_PROFILE=architecture bun --no-env-file scripts/daemon-playground/analyze.ts
```

Daemon preparation uses the new frozen repository, not a historical source capture. Its workload remains 45 runs, 39 successes, six controlled failures and nine approvals. Daemon preparation starts an owned daemon to compile/save definitions and stops it; root must authorize that step too.

Stop the cloud stack with `LOOPY_PLAYGROUND_PROFILE=architecture bun --no-env-file scripts/playground/index.ts stop`. State and Docker volumes remain retained.

# Evidence API and metrics

Harness exports preserve inference from their schemas. Public signatures added or changed in this lane are:

```ts
playgroundProfile(root: string, input: string | undefined)
playgroundConfigSchema(profile: ReturnType<typeof playgroundProfile>)
diagnosticPath(path: string, directory?: string): Promise<string>
approvedDiagnostic(path: string, approvalPath: string, batch: string): Promise<string>
requireCurrentBaseline(path: string, batch: string, directory: string): Promise<{ batch: string; samples: unknown[] }>
requireFreshDurableRoot(root: string): Promise<void>
waitForWorker(url: string, child: Pick<ReturnType<typeof Bun.spawn>, "exitCode">, request?: (url: string, init: RequestInit) => Promise<Response>): Promise<void>
writeStackConfig(settings: Config): Promise<string>
requireFreePorts(): Promise<void>
receiptEvidence(options: {
  root: string;
  identity: SandboxAttemptIdentity;
  authority: Pick<SandboxAttemptAuthority, "read">;
  resultsFor: ResultsFor;
})
```

`playgroundProfile` returns the selected roots, origins, ports, receiptMode, batchPrefix and explicit child environment. `playgroundConfigSchema` returns the selected strict Zod schema. `receiptBindingsSchema` is the exported startup binding parser. Existing `start`, `serve`, `stop`, `status`, `config`, `initialize`, cohort and daemon APIs retain their call signatures. `serve` now lives in `supervisor.ts` and remains exported from `stack.ts`; root-owned `index.ts` exports were untouched.

`receiptEvidence` reads one authoritative terminal record by the hash of `{ root, workspace, executionKey, attempt }`, verifies its plan identity, requires a blob reference, resolves that reference through `resultsFor(workspace).get(ref)`, and checks canonical byte size and SHA-256. It returns only `receiptMode: "durable-object"`, id, identity, admitting session, requestHash, resultRef, resultKind and `resultResolved: true`. It performs no session opening, admission or result publication. Root can create the HTTP client from the architecture config and collect this evidence for actual saved execution identities. Calling the helper alone does not prove a live workload used DO/R2.

Existing metrics commands now read and write only the selected profile paths:

```sh
LOOPY_PLAYGROUND_PROFILE=architecture bun --no-env-file scripts/playground/metrics.ts during-load 3600 2
LOOPY_PLAYGROUND_PROFILE=architecture bun --no-env-file scripts/playground/metrics-matched.ts matched-during-load
LOOPY_PLAYGROUND_PROFILE=architecture bun --no-env-file scripts/playground/metrics-inventory.ts
LOOPY_PLAYGROUND_PROFILE=architecture bun --no-env-file scripts/playground/metrics-segments.ts
LOOPY_PLAYGROUND_PROFILE=architecture bun --no-env-file scripts/playground/metrics-runtime.ts
```

The matched probe preserves direct HTTP measurements separately from shared-client slot wait. Backend queue timing remains in the selected `runtime-queue.jsonl`. Inventory, segment and runtime analysis require the corresponding completed captures; they do not create missing workload evidence.

Architecture SQL metrics accept only a canonical regular file beneath `.loopy/playground-architecture/diagnostics`. Root must supply a verified closed copy and write `.loopy/playground-architecture/diagnostics/closed-copy.json`:

```json
{
  "profile": "architecture",
  "sourceClosed": true,
  "path": "/absolute/path/to/playground-architecture/diagnostics/chosen.sqlite",
  "sha256": "64 lowercase hex digits",
  "batch": "current config batch"
}
```

`sourceClosed` records root's verified observation; this lane does not establish it. The supplied path, SHA-256 and batch must match before SQLite opens. The script still compares all run IDs/statuses with the selected postload API inventory and checks the file hash after close. No shared schema migration runs. Default-profile historical approval remains unchanged and cannot authorize an architecture copy. Daemon SQL analysis selects `.loopy/playground-daemon-architecture/daemon-readonly.sqlite` and architecture daemon evidence.

```sh
LOOPY_PLAYGROUND_PROFILE=architecture bun --no-env-file scripts/playground/metrics-sql.ts postload .loopy/playground-architecture/diagnostics/chosen.sqlite
LOOPY_PLAYGROUND_PROFILE=architecture bun --no-env-file scripts/playground/metrics-daemon-sql.ts
```

# Offline checks and remaining acceptance

See `workload-profile-checks.json` for exact source hashes and line totals. Focused tests passed in both unset and architecture environments. Biome, ESLint and the focused harness TypeScript project passed. Nine temporary source mutations each caused a relevant assertion failure. No test was deleted or moved.

Remaining root acceptance includes actual port checks, first baseline and arming, all workloads, authority/result identity coverage, R2 read counts and write amplification, restart/transport ambiguity/worker loss/timeout/export fencing, browser acceptance, closed-copy verification and final integration. Binding presence and offline composition do not establish actual DO admission or R2 use. The root-owned full check, commits, main integration, remote/cloud execution and shared services remain outside this lane.
