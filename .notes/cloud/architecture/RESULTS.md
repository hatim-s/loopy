# Architecture result

Implementation and the repeated workloads are complete. Final repository checks and scoped evidence reconciliation passed. The final independent evidence review accepted local correctness; main integration is recorded below. Real cloud execution and deployment remain unapproved.

## Persistence and a smaller core

Execution persistence is injected at the runtime composition boundary. Native execution uses `FilesystemReceipts`, including exclusive claims, atomic terminal files and dead-child reconciliation. The Docker bridge takes `SandboxAttemptAuthority` and `ResultsFor`; the repeat stack used a separate SQLite Durable Object for admission, sessions and export guards, with immutable result bytes in local R2. Its filesystem authority directories stayed empty.

R2 is not the mutable run database. Ownership, attempts, waits, schedule advancement and conditional receipt publication need transactional SQL. Immutable results and compiled artifacts belong in object storage. Writable run workspaces still belong to the execution provider. Moving those workspaces to Modal needs provider-specific volume and recovery verification.

The pure reducer stays independent of filesystem, SQL and network APIs. Local and durable hosts now share activation disposition, admission policy and completion conversion. Both retain concurrency slots for retry and rate-limit delays beside waits. Receipt-only polling uses targeted node reads and skips redundant started-receipt writes. Driver-specific shutdown, alarm and lease behavior remains explicit.

These are typed adapter contracts rather than an unrestricted plugin system. An adapter cannot change reducer internals, choose retry rules or bypass persist-before-dispatch. The finite models explore declared state spaces and preserve shortest counterexamples. They improve testability but do not prove all graphs, arbitrary outages or exactly-once external effects.

## What the bugs represented

Several bugs exposed architectural assumptions, rather than isolated syntax mistakes:

- Unknown Docker transport state had been treated as terminal execution state. It now remains unresolved until authoritative recovery establishes an outcome.
- Suspension and release can be interrupted between durable commits. Recovery must select owned suspended runs and preserve their wake deadlines.
- A schedule-local failure had blocked workspace-wide reconciliation. Failures now have per-schedule isolation and persisted retry deferral.
- New due work had not invalidated the daemon's idle wait. Committed queued-run and schedule events now wake it.
- Local and durable activation policy had diverged for retry beside suspension. The shared planner removes that duplicate decision.
- Workerd's binding and row-size limits invalidated otherwise reasonable SQLite queries and summary layouts. JSON-array bindings and separate compact projection rows are tested against actual workerd.

Implementation review also caught lost admission acknowledgements, delayed commits after an empty resolving read, export-token reuse, shutdown drain ordering and unsafe workload evidence gates. Their fixes have causal negative controls and separate review reports. Green happy-path tests were not used as the only acceptance criterion.

## Repeated workload

The same 15 fixture definitions and inputs ran in a fresh `loopies-playground` repository, with four API and backend slots. No ambiguous admission was rerun.

- Cloud-shaped primary workload: 525 runs, 461 successes, 64 exact controlled failures, 125 delayed approvals. All 461 successful exports match independently derived contents, byte sizes and hashes.
- Three separate preflights bring the retained cloud inventory to 528 runs: 464 successes and 64 failures.
- Every one of 1,560 backend attempts, including preflights, has a matching finished DO receipt and verified immutable R2 result. The stopped authority census has no extra attempt, started receipt or active export guard.
- Complete primary SQL census: 4,695 persisted nodes and 4,720 attempts, including 1,552 code attempts. All 25 retry workflows reached attempt two. Map, parallel, sleep, wait, scope and log semantics match the pinned graphs.
- Native daemon workload: 45 runs, 39 successes, six controlled failures and nine approval holds. All 178 filesystem receipts and 272 retained-file checks pass. Restart preserved a pending approval and its finished seed receipt; competing same-home startup was rejected.
- Seven separate Docker/DO/R2 scenarios passed for duplicate admission, lost acknowledgements, reconstruction, export exclusion, actual worker kill, deadline termination and shutdown during an outage.

Approval holds include polling and resolution latency. Thirteen cloud holds exceeded 45 seconds; none resolved before its own scheduled due time. The workload does not establish a hard 45-second observed bound.

The dashboard in personal Chrome showed 15 definitions, 528 runs, 64 failures and zero active or waiting runs. A retry detail showed the controlled first-attempt failure and successful second attempt with its finished receipt. [Screenshots and browser scope](browser-repeat.md) supplement the exhaustive API and database evidence.

## Performance and scaling

The result is mixed, not a general speedup. Native creation-to-first-node delay fell from the prior 4,791–4,997 ms range to 1–9 ms across all 45 runs, median 1 ms and p95 5 ms. Quiescent `/loopies` median fell from 19.96 ms to 8.53 ms. During the cloud workload, mixed-endpoint p95 rose from 886.79 ms to 2,529.62 ms and p99 from 2,150.67 ms to 4,869.37 ms. Backend duration and queue delay also increased. The shared laptop environment was not controlled, and these comparisons do not isolate the cost of DO/R2 storage.

All captured API phases had zero failures. Direct HTTP probes also saw delays, so the filesystem client semaphore is not the only possible source. A separate real-workerd experiment proved that the current Workspace queue holds reads behind provider I/O: six same-workspace reads waited for explicit release, while two other-workspace controls completed during the hold. It does not attribute the historical tails to that mechanism. The production queue remains unchanged because composite run, wait and cursor consistency needs a separate design before broader read concurrency.

On the verified cloud database copy, warm native SQLite medians included 0.0295 ms for latest runs, 0.0634 ms for waiting runs, 0.0119 ms for unfiltered counts, 1.3493 ms for the bounded log scan and 0.8939 ms for the bounded event scan. These are local native SQLite microbenchmarks, not workerd request timings or a production capacity forecast. They do not justify adding indexes. The new grouped-count query was not timed by that capture. Live R2 request counts and write amplification were not instrumented during the 525-run batch. Focused actual-workerd adapter tests count the fresh put, completion verification and duplicate put paths, but those counts are not a live workload cost or throughput measurement. This remains a measurement gap before making cloud cost or scaling guarantees.

The important growth bounds remain explicit:

- Definition metadata reads use zero warm R2 graph reads in the cloud adapter. Listing reads O(D) compact SQL summaries; a full single-definition validation fetches that definition's graph. Cold backfill still reads and validates existing graphs.
- Definition counts use one authoritative O(N) grouped run scan plus O(U + D) mapping, replacing D repeated count scans. U is the number of historical workspace/slug identities. There is no trigger-maintained totals table or status-transition write amplification.
- Indexed cursor pages are approximately O(log N + P), plus payload decoding and view construction. Exact overview and arbitrary time-filtered counts can still scan O(N) matching history.
- Log/event requests inspect at most 2,001 candidates per page. Searching all history still grows with history size.
- A stable durable polling turn uses two full execution reads plus B targeted reads, rather than B full materializations. Graph reconstruction and reducer traversal still grow with graph/execution size; a work budget does not make that CPU cost constant.
- Recovery indexes select started receipts and active export guards without scanning all terminal receipt history. Actual-workerd query-plan tests cover a terminal-heavy fixture.

This establishes correctness at the tested workload, not a maximum throughput or tenant-count guarantee. The per-workspace serialized control plane, wide-graph traversal, historical counts, retention policy and real provider behavior remain scaling boundaries. [The performance report](performance-repeat.md) retains endpoint-level observations, exact comparison windows and limitations.

## Data preservation and evidence

The shared run schema remains 15. Native schema 13/14 upgrades are retained. Copied schema-15 cloud and daemon data preserve IDs, outcomes, tables, epochs and cursors under supported adapters. Cloud metadata projection creation/backfill has actual-workerd size, rollback and generation-race coverage. No personal data migration was performed.

A test isolation defect did reach the personal registry during an earlier broad check. Five synthetic files were narrowly identified, hash-checked, quarantined privately and removed. Payload-bearing assertion logs were deleted or sanitized. Older fixtures now create explicit project boundaries; an ancestor-sentinel test passed. There was no pre-test snapshot of obsolete registry entries, so historical absence of an obsolete same-name file cannot be proved retrospectively. [The work log](WORK.md) and [fixture isolation report](fixture-isolation.md) preserve this incident and its limits.

Raw architecture captures retain their original bytes and hashes. Biome still parses these JSON files, but formatting is disabled only for the two architecture evidence directories so a formatting pass cannot invalidate capture identities. Production and test formatting rules are unchanged.

## Integration and cloud boundary

Fable 5.1 reviewed the architecture before implementation. Independent Sol reviews accepted the corrected receipt, host, data-model and workload boundaries. The final integrated `bun run check` passed build, lint, both TypeScript checks, 1,283 tests and 671,228 assertions across 112 test files. Three tests were skipped and none failed. The separate actual Docker proof covers the opt-in Docker boundary. [Final evidence review](acceptance-review-1.md) accepted local correctness with the live R2 measurement gap above. Main was fast-forwarded from `dee31da` to `7f6976a`, including source commit `69de89c` and the verified evidence. Frozen-lockfile installation and the main package/dashboard build passed. All 467 workload source hashes match in both checkouts.

The user separately authorized landing verified changes on main and the automatic reloads of the existing watched daemon/dashboard. No remote push or deployment is implied. The Modal backend, authenticated staging transport/configuration, provider volume semantics, resource limits, cleanup and rollout verification still need implementation or provider proof. A local R2/DO/Docker success does not grant phase-2 approval.

The reviewed implementation is committed as `69de89c`. The architecture dashboard is served at http://127.0.0.1:15272 with its private generated connection URL in `.loopy/playground-architecture/dashboard.url`. The restarted stack retains the exact 528-run inventory. Start/stop commands and state ownership are in [the workload profile](workload-profile.md); stopping retains the fixture repository, database and artifacts.

The authorized main reload briefly failed during the multi-file checkout. Bun retained the failed watcher PID, which prevented daemon startup through its liveness check. Root replaced only that failed watcher process with the same command, home, port and concurrency. The pre-existing workflow worker and its descendants remained alive; no personal database or receipt file was manually changed. The replacement daemon listens on 4310 and returns the expected unauthenticated 401. Both dashboards return 200. This verifies HTTP availability, not authenticated personal workflow outcomes. Exact process and verification receipts are in `.notes/cloud/evidence/architecture/main-watcher-recovery.json` and `main-service-verification.json`.
