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

The runtime, real Docker journey, local workerd tests, failure journey and final repository check have passed. Independent review 2 has no blocking code findings. Authenticated dashboard browser QA has now passed. Additional real Docker CLI transport-failure verification passed both scenarios, including a parent rerun. Phase 2 is not authorized. Later sections record the chronological evidence and limits.

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

## Authenticated dashboard acceptance, 2026-10-22

- User opened the local credential URL in personal Chrome. The newer user tab was connected; the earlier login-tab observation was stale. No credential was printed in chat or saved in evidence. Refresh preserved authentication and returned to Live.
- Resolved the existing synthetic approval run `bdced5e6-4e74-4a0a-ba3b-266778a5d64d` through the dashboard with `{"approved":true}`. It changed live to Succeeded and returned version 1, preserving its older pinned revision `57ff7bbc` despite a newer saved definition.
- Started `cloud-journey-execution` through its input form with name `browser-qa`, chooseYes true and items `[3,5]`. Run `5972833b-2ce1-4e32-a5a5-4051f4c9482e`, revision `d5fed93f`, succeeded in 4.1 seconds. Output doubled items to 6 and 10, selected the yes branch, returned the bundle greeting and descriptor output, and completed the retry fixture.
- Inspected firstfail attempt 1's exit-code-7 retry and attempt 2's successful finished receipt. Opened map item 1, verified output `{"doubled":10,"index":1}` and finished receipt, then expanded its scoped log payload `{"item":5,"index":1}`.
- Logs and events showed persisted records. Filtering by the browser-created run retained the filter across tabs. Event 909 contained the completed run and transaction identity. Run details and the read-only graph rendered; graph fit settled at 36 percent for the wide 19-node graph.
- Screenshots: `evidence/dashboard-approval.jpg` and `evidence/dashboard-execution.jpg`. The user tab remains on the successful run. No new UI tests or production edits were needed. This is desktop Chrome acceptance of local fixture behavior, not remote-provider or responsive-device verification.
- A new Sol test task uses high reasoning and Standard speed, advertised as `serviceTier: default`. It is checking real Docker CLI transport failures in isolated resources. No passing result is claimed yet.

## Real Docker CLI transport faults

- The Standard-speed Sol task completed with matching task/run identity, `result_available` and no pending child run. No causal runtime bug was found.
- Killed a real `docker wait` client with SIGKILL. The owned worker continued; persisted receipt recovery returned success with exactly one start and one finish marker. Duplicate admissions did not create or restart a worker.
- Selected real inspect/list invocations used an absent Unix socket while independent named-context calls observed the live worker. Reconstructed the service object, retained original admission/container/deadline, and confirmed timeout termination. The parent rerun completed the timeout 134 ms after the deadline.
- Parent fixed only the harness's commit guard to permit its own committed scripts and the runbook. The corrected harness passed both scenarios. Independent parent cleanup inspection confirmed zero owned containers and all four receipt-derived volumes absent. No ports were opened or existing services changed.
- Evidence: `evidence/transport-failure.json`; command and scoped checks: `transport-proof.md`. These are invocation-scoped CLI faults and service-object reconstruction. The Docker daemon remained healthy; this does not prove daemon failure or remote-provider parity. Earlier process-kill evidence remains separate.
- A read-only Standard-speed Sol assessment is checking what local preparation is still needed to make the phase 2 deployment packet concrete. It cannot execute or authorize cloud actions.

## Final check after transport proof

`bun run check` exited 0 after the new harness and runbook change. Build, Biome/ESLint and both TypeScript configurations passed. Tests: 1,147 passed, 3 skipped, 0 failed, 5,197 assertions across 78 files, 67.13 seconds. Log: `evidence/check-transport-final.log`. The real-Docker transport journey passed separately because it is an explicit local resource test. No tests were deleted or moved.

## Local preparation for a bounded provider probe

The approval-readiness review found no new phase 1 acceptance blocker. Full staging still lacks the provider adapter and deployable operations. The immediate proposal is narrowed to a fixed Modal probe because the public SDK does not expose process reattachment and the workspace/recovery assumptions need provider evidence. A Standard-speed Sol task owns only new probe scripts and dedicated boundary tests. Parent pinned `modal@0.11.1`, inspected its source as text and queried public base-image metadata. No Modal client was instantiated, credentials loaded, cloud resources created or cloud workload executed. Target workspace/environment names are pending; they do not constitute approval.

## Probe preparation full check

`bun run check` passed build, lint, both TypeScript configurations and 1,162 tests, with 3 skips, zero failures and 5,298 assertions across 79 files in 69.45 seconds. Log: `evidence/check-modal-probe.log`. The 15 added probe tests use fake provider identities and local Bun children. They do not import the Modal runtime or prove provider behavior. Independent review is pending.

The transport fixture's historical commit whitelist was removed so unrelated committed preparation does not prevent rerunning it. Worktree/branch identity, actual HEAD, runtime source hashes and unchanged image verification remain. Both real Docker cases passed again at 17:58:31 through 17:58:52 UTC, with zero owned containers, volumes, background processes or active runner calls remaining. Scoped Biome and ESLint passed after this fixture-only edit. No tests were deleted or moved.

The fresh probe review requested three fixes before live approval: atomic exclusive journal publication, app admission across V1/V2 sandboxes, and separately approved cleanup after source changes while preserving original resource identity. Report: `modal-probe-review-1.md`. The implementation follow-up is local only; a fresh review will follow. Phase 1 acceptance remains unchanged.

## Check after probe review fixes

The implementation follow-up fixed all three findings and passed 18 focused tests with 145 assertions. Each targeted mutation caused its new test to fail. The seven-script implementation hash is `8b2d50cd4168e79bf74bdc04840f2ee19c15548b59019fa032a1a88ae8ed342a`. A fresh independent round 2 review is running at Standard speed.

Parent `bun run check` exited 0 after those fixes: build, Biome/ESLint, both TypeScript configurations, 1,165 passed, 3 skipped, zero failed, 5,342 assertions across 79 files in 69.10 seconds. Log: `evidence/check-modal-probe-final.log`. No existing tests were deleted or moved. The new probe comprises 1,920 TypeScript lines including 710 test lines; the separate transport fixture simplification removes 23 lines. No Modal SDK runtime import, provider call or credential read was needed. Target selection and actual cloud approval remain pending.

## Probe review accepted

Fresh independent round 2 found no blockers and traced each fix to its round 1 failure mechanism. It independently passed 18 tests with 145 assertions and verified implementation/test hashes. The T3 task completed with `result_available`, no pending child work and Standard speed. Report: `modal-probe-review-2.md`. No code changed after the final full check; only reports and this handoff were updated. User-selected Modal target names and explicit execution approval remain outstanding. Main remains clean at `dee31da64781c04313b2555a5e697da724e06ef8`.
