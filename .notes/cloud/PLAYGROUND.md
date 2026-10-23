# Loopies playground workload

The workload, browser QA, independent reviews and final repository checks are complete. Everything is on `cloud-integration`. Cloud execution and a main merge remain unauthorized.

## Runs and outputs

Before this exercise, the retained local stacks contained 22 workflow runs: 18 succeeded, two failed and two suspended at approval. Ephemeral automated tests and direct executor attempts were excluded. See `evidence/pre-playground-runs.json`.

This exercise created 573 workflow runs:

- Group A: 200 primary runs, 172 succeeded, 28 exact controlled failures, 25 approvals.
- Group B: 200 primary runs, 172 succeeded, 28 exact controlled failures, 25 approvals. Its 25 retry workflows completed at attempt 2.
- Group C: 125 primary runs, 117 succeeded, eight exact controlled failures, 75 approvals.
- Three separate cloud preflights succeeded, including one held approval.
- The separate Bun daemon comparison completed 45 runs, 39 succeeded and six exact controlled failures, with nine approvals.

All expected outcomes matched. The 525 primary cloud runs have 461 successful, semantically verified exported results and 64 controlled failures. Their 125 approval holds were scheduled for 10–45 seconds; observed holds reached 48.633 seconds under load. These are scheduled delays, not a hard observed upper bound. The cloud dashboard retains 528 runs, 464 succeeded and 64 failed, with none active or waiting. The 45 daemon runs remain in their separate state root.

A later bounded validation of the daemon wake repair added three successful HTTP runs in disposable state. They are separate from the 573-run exercise and are not present in the dashboard. Their receipt remains in `evidence/daemon-wake-smoke.json`.

The actual Git repository is `.loopy/playground/loopies-playground`, branch `playground`, seed commit `9e649e9a8abcb2ec20e4379190b893c6876931b0`. Its frozen source hash is `a213d51dab78b89a140ebcc1c792daa18558d9fb428330bdc21b650400de9c89`. It contains 15 workflows, with 25 runs each except two workflows with 100 primary runs each. Tracked source copies live under `packages/loopy/_tests_/fixtures/playground`.

Each Docker run seeds, reads and modifies a logical repository in its isolated volume. Nodes and retries of one run share that volume. Authenticated artifact export verifies bytes, SHA-256 and batch/ordinal/slug before collecting outputs into the host repository at `results/<batch>/<slug>/<runId>.json`. Containers do not mount the host repository or personal home. All 461 primary successful outputs passed cohort-specific semantic validation. The daemon comparison separately verified 272 retained file hashes and 45 semantic outcomes.

## Measurement and fixes

Empty and small-data baselines passed with 140 and 180 API samples. During the actual primary interval, 1,201 shared-client samples had no failures. Their p95 was 886.79 ms, but the measurement includes the filesystem API semaphore and full-body buffering. It is not server-only latency.

A separate 36-request matched segment bypassed that semaphore for direct HTTP reads. Under load, direct maxima were 594 ms for runs, 621 ms for loopies and 561 ms for events. The same bounded post-load probe observed maxima of 20.4, 32.3 and 12.3 ms. Six pairs per endpoint and changing data do not support an exact queue penalty or attribution to SQL. Native copied-SQL warm medians were below 1.5 ms for the tested statements. No index change was justified.

The exercise found and repaired two concrete runtime defects:

1. `/runs?limit=100` and `limit=200` failed in Workerd because pending-hook lookup exceeded its SQL variable limit. The query now passes one JSON array to `json_each(?)`. Real Workerd reproduced the original error and passed the repair. On the populated stack, pages of 200/200/128 exactly matched all 528 saved IDs and statuses. Limits 99/100/200 pass; 201 remains rejected by the API contract.
2. All 45 daemon runs waited 4.791–4.997 seconds before their first node despite fast admission. The daemon subscribed to durable wake events but missed queued creation. It now wakes its active loop on committed queued creation and schedule saves. Negative controls reproduced four missing-wake failures, focused tests passed, and three isolated HTTP runs reached their first node in 7/1/2 ms. This small verification is not a repeated 45-run benchmark.

The cloud API tail cause remains unresolved. Native SQL diagnostics do not establish Workerd or remote-provider performance. The daemon comparison uses host Bun/SQLite and serial execution; cloud-shaped runs use Workerd and Docker with separate concurrency limits. These are behavior checks, not matched hardware throughput benchmarks.

## Durability and evidence

The driver persists admission intent before POST, fails closed on ambiguous responses, validates exact controlled failures, and resumes completed jobs without new admissions. Approvals retain intent and resolved-hook history. Independent review caught a pressure-lock bypass before the load. Its correction waits for the owner, rechecks ABORT, requires a fresh successful sample and rejects dead owners without stealing locks. Four backend slots and sampled memory guards bounded this local workload; they do not prove remote sandbox quotas.

Live readonly SQLite snapshot attempts failed safely with SQLITE_CANTOPEN. After API measurement ended, the driver stopped only its owned stack and copied the entire quiet DO tree, including sidecars. Source and raw hashes, sizes and mtimes stayed identical. A working copy was backed up into a standalone DELETE-mode diagnostic database. It passed integrity checks and matched all 528 API IDs and statuses. The final diagnostic SHA-256 is `0d0ce744814caf442edf3c3fde3e74b129019f7602db4bb393a431cd341697fa`. Source and raw databases were never opened by SQLite during analysis.

The daemon's stopped readonly backup separately matched all 45 IDs and statuses, integrity OK, SHA-256 `5f83e877a93e335e4f5ac5d1586c5dea9db6523bf9de9614dd8c377774297771`. Complete accounting is 457 node executions, 466 attempts, 72 scoped execution records, 400 logs and 178 finished effect receipts. Root-only dashboard snapshots are preserved and are not misrepresented as full scoped execution counts. The pagination source changed during that batch; both daemon starts loaded the earlier source, so the batch does not reverify the SQL fix.

The suspended daemon restart preserved its pending hook and completed seed receipt. Competing same-home startup was rejected. This batch does not prove stale-owner fencing or recovery of an unfinished external effect; the earlier phase-1 failure journeys provide separate evidence for their tested cases.

## Current local state

The populated playground stack is running at API 15070, sandbox 15071, dashboard 15072 and inspector 15073. Its process manifest is `.loopy/playground/processes.json`. Browser QA in personal Chrome verified overview counts, fifteen definitions, pagination, failure filtering and node details, resolved approval history, logs and event payloads. The authenticated overview tab is retained. No captured console errors were present at the end of QA. Some failure previews begin with minified bundle stderr; the full detail exposes the authored error.

The daemon comparison is stopped and port 15170 released. Original services on 4310/4173 and 14870–14873 remain untouched. State and exports are retained. A readonly resource inventory found 1,560 exited playground-owned containers and 2,088 existing receipt-named volumes, with no running attempt containers. Nothing was pruned. Host playground state occupies about 606 MiB and daemon state about 10 MiB; Docker volume bytes were not measured.

From this worktree:

```sh
bun --no-env-file scripts/playground/index.ts status
bun --no-env-file scripts/playground/index.ts stop
bun --no-env-file scripts/playground/index.ts start
```

Stop retains data, containers and volumes and does not stop the shared Colima VM. Start refuses occupied ports or an existing process manifest. Private credentials and the dashboard bootstrap URL stay under ignored `.loopy/playground`; never paste them into chat or evidence. Current-batch cohort summaries prevent accidental duplicate execution. See the driver report for preparation, arming and explicit recovery procedures.

## Reports and validation

- `playground-driver.md` and `evidence/playground-driver-*.json`: source freeze, admission safety, preflights, load summaries, snapshots and populated pagination verification.
- `playground-cohort-a.md`, `playground-cohort-b.md`, `playground-cohort-c.md`: run IDs, exact failure expectations, approval holds and artifact semantics.
- `playground-performance.md`: request samples, client/HTTP/SQL boundaries, plans, timings and limitations.
- `playground-daemon.md`: 45-run behavior, file semantics, restart evidence, complete execution counts and source overlap.
- `pagination-fix.md`, `pagination-review-1.md`: original Workerd failure, repaired contract and independent approval.
- `daemon-wake-fix.md`: negative control, focused tests and three-run HTTP verification.
- `playground-evidence-review.md`: independent reconciliation of counts, hashes and performance conclusions with no material findings.
- `playground-browser-qa.md`: observed Chrome checks and screenshots.

Task IDs and Standard-speed model options are retained in `tasks.json`, including the two bounded Luna helpers. No cloud calls, deployments, main edits, merges or pushes were made for this exercise. The daemon wake review approved the fix with no blocking correctness findings. Its fresh verification passed 27 tests and deterministic wake-race, schedule-recomputation and manual-tick checks. See `daemon-wake-review.md`.

Final command `bun run check` exited 0. Build, Biome/ESLint and both TypeScript configurations passed. Tests reported 1,170 passed, three skipped, zero failed and 6,606 assertions across 79 files. The skips are two Linux-only process cases and the opt-in Docker integration test; earlier dedicated real-Docker journeys remain separate evidence. Full output is `evidence/check-playground-final-3.log`. Earlier check logs preserve formatting and tooling-type failures corrected before this passing run.

`git diff --check` passed for code changes. Captured tool logs later exposed trailing output whitespace during the staged check; it was normalized without changing diagnostic text, and the complete final diff was rechecked. The exercise adds 7,182 TypeScript lines and deletes 13 across 95 files, mostly the 15 workflow fixtures, bounded workload drivers, metrics and proof scripts. Production changes are 12 added and three deleted lines across daemon wake selection and pending-hook lookup. The prior manual-wake test was replaced by committed-creation coverage; no unrelated tests were deleted or moved. The standalone three-run smoke runner was moved from notes into the dedicated test fixtures directory without re-execution. Generated credentials were checked against all candidate files with zero matches. Raw JSON timing and semantic evidence account for most retained text lines.

## Readiness follow-up after the completed workload

A subsequent source audit and isolated Workerd probe found a remaining large-map pagination defect. `SqliteQueryNodes.scopeItems` expands selected item indices into separate SQL bindings, plus run ID, map node and parent scope. The API accepts up to 200 items. Using the production portable store and DurableSqlDriver in an ephemeral SQLite Durable Object with 205 synthetic scope rows, limit 97 returned 97 items; limits 98, 100 and 200 threw `too many SQL variables at offset 322: SQLITE_ERROR`. The temporary runtime and files were removed; existing services, databases and workflow runs were untouched. No production fix was made during this readiness assessment.

This is a distinct open defect from the repaired pending-hook query for run pages. The completed 525-run workload and 1,170-test result remain valid for their tested cases, but do not establish correctness for these larger map pages. Full cloud deployment also still needs the Modal adapter, remote durable admissions/receipts, staging auth/assets/configuration and bounded provision/verify/stop/rollback operations listed in PHASE-2.md.
