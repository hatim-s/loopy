# Phase 1 evidence log

## Initial verification, 2026-10-22

- `pwd`, `git status --short --branch`, `git rev-parse HEAD`, `git rev-parse --git-common-dir`: clean requested worktree and branch at dee31da; common repository is `/Users/hatim.shakir/projects/loopy/loopy.git`.
- T3 live catalog: parent `gpt-6-astra`, reasoning high, default service tier. Sol children use `gpt-6.1-sol`, high, priority with returned identity checked.
- Bun 1.4.0. Docker client 29.8.1. Default Docker daemon unavailable. Colima available; existing unrelated profiles will not be reused or stopped.
- Existing listeners inventoried. 4310 and 4173 remain untouched. Initial proposed ports: API 14870, executor 14871, dashboard 14872, inspector 14873, subject to a fresh availability check before startup.
- Personal Chrome profile `Hatim` selected for platform docs and later dashboard QA. No existing user tabs altered.

## Task ledger

- `loopy-cloud-store-assessment-01`: read-only storage/host architecture assessment, Sol high/priority.
- `loopy-cloud-portable-store-01`: portable SQL store driver implementation, Sol high/priority. Owns `src/store/**` and `_tests_/cloud-sql-driver.test.ts`.

Full T3 task IDs are recorded in `tasks.json`.

## Acceptance status

The runtime, real Docker journey, local workerd tests, failure journey and final repository check have passed. Independent review 2 has no blocking code findings. Phase 1 acceptance remains open for authenticated dashboard browser QA. Phase 2 is not authorized. Later sections record the chronological evidence and limits.

## Local services and first platform checks

- Started dedicated Colima profile `loopy-cloud-phase1` with 2 CPUs, 3 GiB RAM, 16 GiB data disk, no host mounts, no SSH agent/config integration, and `--activate=false`. Docker context is `colima-loopy-cloud-phase1`. Colima necessarily stores its named VM under its application-owned state directory; no unrelated VM was changed.
- Pinned Wrangler 4.152.0, Miniflare 4.20260730.0, workers-types 5.20261022.1. Compatibility date is 2026-07-30 to match the installed local workerd build.
- `bun run cloud:start` starts only loopback API 14870, sandbox service 14871, dashboard 14872, inspector 14873. State/logs/local fixture credentials live in ignored `.loopy/cloud`. Child environment excludes inherited Cloudflare/Modal credentials; Wrangler is explicitly `--local`.
- API `/health`, sandbox `/health`, and authenticated `/api/loopies` returned 200. The latter initialized real DO SQLite and returned an empty registry. This proves initial platform wiring, not workflow execution.
- First API attempt exposed a dotenv quoting bug. Corrected single-quoted JSON configuration, rotated disposable local credentials, and added a generic Worker error boundary so Wrangler does not return request-bearing diagnostic HTML to API clients.
- Initial `bun run check` was started while delegated edits were already in progress. Build passed, lint stopped on concurrent formatting. It is not a clean-baseline result. Final frozen-source verification is still pending.
- Shared service focused checks: 57 tests and 3 architecture tests passed. Portable SQL driver: 35 new checks plus 104 targeted store checks passed on Bun SQLite. R2 registry tests use real local workerd/R2. Durable activation checks: 14 passed. These are component results, not the final matrix.

Cloudflare alarm docs read in personal Chrome: https://developers.cloudflare.com/durable-objects/api/alarms/. Alarms are at-least-once with bounded platform retries; the implementation writes a recovery alarm before work and reschedules on downstream errors. Remote failover is unverified.

## Integrated journey and first review

- Journey command: 11 checks passed against the live local Wrangler/Docker stack. Evidence is evidence/journey.json. Covers branches, map/parallel, controlled retries, logs, approval validation, pinned revisions, pagination, SSE reconnect and workspace denial. This is fixture behavior, not throughput or production parity.
- Actual workerd SQLite/R2 suite: 10 tests, 63 assertions passed. Transaction rollback, stale-owner fencing, eviction persistence, schedule deduplication, wait resolution, whole-transaction retention, conditional R2, auth/isolation and alarms were exercised. It does not prove a crash during physical disk commit or remote failover.
- Independent review 1 requested changes, recorded in review-1.md: interrupted suspension can strand ownership; one due schedule error can block unrelated work; Docker transport errors can abandon deadline monitoring of a live container; accepted definition capacity can break listing-dependent operations. Dedicated fixes and meaningful tests are in progress.
- Real process-crash, worker-termination and schedule-overlap journey is being built on a separate local stack. Existing 14870–14873 services remain available.
- Dashboard browser QA is pending the user opening the locally generated credential URL. Browser safety rejected opening the local credential file; no alternate browser/file access was used to bypass it. The API/dashboard server is running, but browser acceptance is not yet claimed.
- No remote resources or workloads were created, no main files were changed, and no merges were made.

## Recovery fixes and second review

- Review 2 found no blocking code findings. All four prior findings have causal fixes. See review-2.md for inspected source hashes and the review's 101 targeted passing tests after a timeout-only rerun.
- Scheduler suite: 16 tests cover same-token and expired/fresh foreign owned suspensions, full concurrency, repeated release failure, future sleeps and indefinite waits, invalid schedule input, transient errors, committed-fire response loss and a full failing schedule batch.
- Docker suite: 13 Docker-enabled tests passed, including bounded artifact reads and synthetic transport fault recovery. Transport uncertainty keeps the original receipt started and monitors the original container under its persisted deadline.
- Actual failure journey: 7/7 passed. Both services were killed during an observed effect, with 14 seconds offline; restart reconciled completion on attempt 1. Killed worker failed uncertain within 3.2 seconds without retry despite configured attempts=3. One-second timeout stopped execution within 2.7 seconds. Approval survived restart. Consecutive real minute schedules had two Docker workers running concurrently; restart added no duplicate.
- Failure journey cleanup verified zero owned processes/containers/volumes and free ports 14970/14971/14973. It removed exactly 5 containers and 10 receipt-derived volumes. It left the main local stack untouched.
- Actual artifact journey passed content, byte count, SHA-256, authentication, workspace isolation, traversal rejection, missing file/attempt and unchanged run assertions. This exports the terminal run's current workspace file, not historical per-attempt contents.
- Conservative rate quota is now documented in apps/cloud/README.md and tested in cloud-durable-host.test.ts. Failed pre-admission transport consumes quota, retains attempt 1 and its owner, and does not attempt admission again until the window opens. Durable-host suite: 15 passed.
- Current full check attempts have passed build, then found generated-evidence JSON formatting and new test-script spacing. Those are corrected; a frozen-source full check is running. No failed check is being represented as a passing baseline.
- Runtime source did not change after the second review. Subsequent changes were documentation, the quota test and test-script formatting.
- Phase 2 draft is in PHASE-2.md. Official pricing and Modal SDK support were read in personal Chrome. The draft identifies remaining provider adapter/configuration work and does not authorize it to call cloud services.

## Full-suite timing failure

The first full check to reach tests passed build, lint and both TypeScript configurations, then reported 1,146 passed, 3 skipped and one failure. The unchanged HTTP slow-reader test exceeded its 3-second disconnect-observation deadline. Its streaming backpressure implementation is the existing implementation moved into the portable service. An isolated rerun passed with 267 assertions in 6.91 seconds. No timeout or runtime behavior was changed to make it pass. The failed full log is check-sse-timeout.log and the focused rerun is sse-rerun.log. A second complete check is running; this timing sensitivity remains disclosed even if that check passes.

## Verified checkpoint

- Final `bun run check` exited 0. Build, Biome/ESLint, both TypeScript configurations and 1,147 tests passed; 3 skipped; 5,197 assertions. Full log: evidence/check.log. Test time: 82.44 seconds. The earlier HTTP timing failure remains documented above.
- Skips are two Linux-only sandbox tests on macOS and the opt-in real-Docker test. The Docker-enabled cloud sandbox suite was run separately with the named context and passed all 13 tests.
- `git diff --check` passed. Main was rechecked clean at dee31da64781c04313b2555a5e697da724e06ef8. No merge, push, cloud deployment or provisioning occurred.
- Existing tests were not removed or moved. New durable/store/service/provider tests live in the dedicated package test directory. The obsolete local service view implementation moved to the shared service layer unchanged.
- The live fixture stack remains on 14870/14871/14872/14873. Its private state and disposable credentials remain in ignored .loopy/cloud. Failed intermediate formatting logs were retained in ignored .loopy/cloud/evidence-history.
- Remaining phase 1 handoff: run `bun --no-env-file scripts/cloud/open-url.ts` from this worktree and open its printed URL in personal Chrome without pasting the credential into chat. Browser safety blocked reading the local credential file. The dashboard remains at its unauthenticated screen, so no authenticated visual/interaction acceptance is claimed.
- Phase 2 approval is not requested while phase 1 acceptance is incomplete. PHASE-2.md is a draft resource/cost/cutover plan with provider implementation prerequisites, not a deployable or approved rollout.
