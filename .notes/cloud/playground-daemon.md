# Local Bun daemon playground

Status: complete. The single authorized batch ran from 2026-10-22T20:35:11.372Z through 20:41:07.823Z, after cloud measurements and samplers finished. All 45 real daemon runs matched expectations: 39 succeeded and 6 failed for the intended fixture reasons. No rerun occurred. All owned daemon processes stopped, port 15170 is free, and all state and artifacts remain.

The runner owns only port 15170 and processes it starts. It checks that the port is unused, rejects an existing live daemon for its isolated home, and checks the discovered PID before every authenticated API request. It never adopts or stops another process.

All paths below are relative to `/Users/hatim.shakir/projects/loopy/cloud-integration`.

| Purpose | Path |
| --- | --- |
| Isolated daemon home | `.loopy/playground-daemon/home` |
| Frozen fixture source copy | `.loopy/playground-daemon/loopies-playground` |
| Workflow workspace | `.loopy/playground-daemon/workspaces/<slug>` |
| Repository read and write directory | `.loopy/playground-daemon/workspaces/<slug>/loopies-playground` |
| Retained repository files per run | `.loopy/playground-daemon/artifacts/<runId>/loopies-playground` |
| Separate API client configuration | `.loopy/playground-daemon/client.json` |
| Closed-database copy for SQL diagnostics | `.loopy/playground-daemon/daemon-readonly.sqlite` |
| Run evidence | `.notes/cloud/evidence/playground-daemon.json` |

The source comes from the driver's frozen Git repository at `.loopy/playground/loopies-playground`. The isolated copy preserves fixture bytes and source hashes. Each selected workflow has its own workspace. Runs are serial because the fixtures use fixed repository file names, including retry markers and result artifacts.

The upstream seed commit is `9e649e9a8abcb2ec20e4379190b893c6876931b0`. The upstream source marker is `a213d51dab78b89a140ebcc1c792daa18558d9fb428330bdc21b650400de9c89`. The isolated normalized fixture-tree hash is `4623ccc20a2f9bfb824dc0f0c8ce848401ae960d336e8c21f1dabb08d5642bfa`. The two hashes use different path prefixes and are not interchangeable. Exact graph revisions and paths are in `evidence/playground-daemon-preflight.json`.

## Executed runs

Nine cases each run through the actual daemon, worker subprocesses and host sandbox:

- `playground-a-lint-report`: map, branch, source reads and report writes.
- `playground-b-parallel-build`: parallel builds and controlled policy failure.
- `playground-b-retry-marker`: safe first-attempt marker and a second attempt.
- `playground-c-repository-validation`: parallel file validation and controlled final failure.
- `playground-c-security-review`: approval, source checks and publication.

Every input has `batch`, `ordinal`, `fail` and `items`. The batch is `playground-daemon-45`. Ordinals 1 through 9 use `[3, 7, 11, ordinal]`. Ordinal 5 sets `fail:true` for each workflow. Security-review ordinal 8 receives `{approved:false}`. Actual totals matched the planned 39 succeeded and 6 failed. All nine approvals were resolved after observed holds of 10,003 to 12,005 ms.

Run `e7e2ab5f-0e76-4cbb-987b-0fdacec00e74`, the first security review, survived an owned daemon SIGKILL while suspended after its seed effect completed. Its pending hook and finished receipt hashes were unchanged after restart, and the original seed receipt remained unchanged through final success. A competing daemon for the same home exited 1 with the expected already-running error. These checks do not prove stale per-run owner-token fencing or recovery during an unfinished external effect.

The two owned daemon PIDs were 32651, started at 20:35:11.478Z, and 33241, restarted at 20:35:16.998Z. The batch lock `.loopy/playground-daemon/load-started.json` remains in place and prevents automatic batch re-admission.

## Complete evidence

- `evidence/playground-daemon.json` retains every input, expectation, run ID, terminal status, API timing, root-node snapshot, wait, receipt hash and repository file inventory. Its final API census exactly matches the diagnostic copy's 45 IDs and statuses.
- `evidence/playground-daemon-executions.json` contains the complete read-only SQL execution, attempt, log and revision records. Dashboard snapshots intentionally contain root executions and scope summaries. Their initial node counters omit scoped map children, and their log arrays are empty by contract. Use the supplementary records for complete counts.
- `evidence/playground-daemon-semantics.json` records 45 semantic checks and 272 retained-file byte/hash checks, all passing. It verifies map item counts, parallel build sizes, retry-updated file contents, repository validation hashes, approval publication and denied publication.

Complete totals are 457 latest executions, 466 execution attempts, 72 scoped executions, 400 logs and 178 finished external-effect receipt files. All 45 stored graph revisions match compile/save preflight. Each retry-marker run reached exactly attempt 2. Raw API snapshots remain unchanged; the SQL supplement resolves their intentional scope limitation.

The final standalone backup is `.loopy/playground-daemon/daemon-readonly.sqlite`. Its integrity result is `ok`; its complete run IDs and statuses match both the source snapshot and the 45-record API census. Source sidecars before and after backup were WAL 0 bytes and SHM 32,768 bytes. Only the diagnostic destination was finalized to DELETE journal mode. No constructor migration ran against either diagnostic database.

## Runtime finding

Admission HTTP calls were fast: median 1.42 ms, p95 6.31 ms, maximum 10.96 ms. The first recorded node appeared 4,791 to 4,997 ms after run creation, with a median of 4,876 ms. Server lifecycle median was 5,529 ms. These measurements identify an activation delay before the workflow begins, not an execution-worker throughput limit.

The source supports a missing queued-run wake as the likely mechanism. `packages/loopy/src/host/daemon.ts:78` subscribes only to `run.kind === "woken"`; `service/routes.ts:169` invokes `startRun` without waking the daemon; `service/service.ts:186` creates a queued run. The idle wait is capped at five seconds in `host/daemon.ts:253`. This inference was reported to root before any runtime fix. No runtime implementation changed in this task.

The batch lasted 356,451 ms and ran serially. Observed completion median was 5,676 ms and p95 17,281 ms; these include the intentional holds, 200 ms polling and output capture. They are not maximum-throughput measurements.

## Source overlap

Both starts captured the same full runtime-source SHA-256 before spawn and after readiness: `7c7561e311c391ef77c32b745a56d1e05fa08a961ccc380b22345259a5c60833`, across 266 TypeScript files. The `query-runs.ts` SHA-256 at both starts was `2bdd61c755d2fe78877f4d798e8e3ee5448fa0a14d6e7caff067b62bde255417`.

The separately assigned pending-hooks SQL change modified `query-runs.ts` at 20:37:18.495Z during this batch. Its end hash was `8383ce0afc84e83047397e0606a6fa1ad1ea9950bb1443540c6750d2ee101728`; full end-source hash was `2cac5bce764c23abe78c25a017a52264b931eb91c23ebe9ac971a43e391f332e`. The already-running Bun daemon retained its startup module imports. This run does not verify the new SQL implementation or establish its performance effect. Exact observations are in `evidence/playground-daemon-runtime-end.json` and the primary evidence's `starts` array.

## Reproduction

Prepare only after the driver freezes its source repository:

```sh
bun --no-env-file scripts/daemon-playground/prepare.ts
```

This uses the public CLI to compile and save all five workflows through the isolated daemon HTTP service, records revisions and source hashes, then stops its daemon. It creates no runs.

The batch was launched exactly once with:

```sh
bun --no-env-file scripts/daemon-playground/run.ts --root-load-gate
```

Do not repeat that command against retained state. The exclusive batch marker intentionally requires manual reconciliation. Offline verification is repeatable without executions or a daemon restart:

```sh
bun --no-env-file scripts/daemon-playground/analyze.ts
```

The runner records input, expected status, actual run ID, admission and observed completion timing, node attempts, retry history, logs, waits, repository file hashes and artifact identity. It retains source, state and copied output files, stops only its owned daemon, then uses SQLite's backup API from a read-only source connection. It finalizes only the diagnostic destination's journal mode to DELETE before closing it and reopening it read-only. It runs no store constructor or schema migration against the diagnostic copy.

The copy receipt records source WAL/SHM/journal sidecars, integrity-check output and source/copied run IDs and statuses. A successful 45-run copy must match the final 45-record API census exactly. A failed or incomplete backup remains a diagnostic gap.

The zero-run backup preflight found that a copied WAL-mode header could not reopen read-only in Python. That failed copy remains at `.loopy/playground-daemon/preflight-readonly.sqlite`. Finalizing the destination journal mode produced a standalone copy that reopened read-only with integrity `ok` and identical zero source/copied runs. The source sidecars remained unchanged at WAL 0 bytes and SHM 32,768 bytes. This verifies the backup mechanism only; it is not a 45-run completeness result. Evidence is `evidence/playground-daemon-backup-preflight.json`.

An expected failed case must contain its frozen fixture's controlled error text. A runtime or ownership error does not count as an expected failure. An unexpected outcome stops new admissions and preserves evidence.

## Validation and limits

Scoped TypeScript, ESLint and Biome checks pass for `scripts/daemon-playground`. Exact commands and output receipts, owned-process exit checks, file hashes and backup SHA are in `evidence/playground-daemon-checks.json`. The runner adds 1,459 code lines and deletes zero. The full check remains parent-owned and was not run here. No tests were deleted or moved. All changes are new runner/report/evidence files; no production code, fixture source, existing service, Docker context, personal home, commit or push changed in this task. Existing core test counts are not throughput evidence.

This is a Bun daemon on the host OS with a local SQLite database and sandbox worker processes. Cloud measurements use Cloudflare Durable Object scheduling and Docker with different resource caps. Latencies must be labeled by architecture and environment. The serial workload checks execution behavior and persistence; it does not establish daemon maximum throughput.
