# Phase 1 independent review

Verdict: changes required. Three P1 correctness blockers and one P2 capacity failure remain in this snapshot. Passing component tests do not cover these failure paths.

## Snapshot and scope

- Review started at `2026-10-22T16:28:05Z`; findings rechecked at `2026-10-22T16:33:06Z`.
- Checkout `/Users/hatim.shakir/projects/loopy/cloud-integration`, branch `cloud-integration`.
- HEAD and comparison base both `dee31da64781c04313b2555a5e697da724e06ef8`. The implementation is uncommitted.
- Tracked diff at the final read: 29 files, 602 added lines, 1,397 deleted lines. There are also 61 untracked files across the cloud/sandbox apps, shared service, durable host, portable SQL, cloud tests/fixtures and scripts. Those new files are included in this review, but excluded from Git's tracked diff statistics.
- Classification: major feature. The shared service and SQL extraction support that feature and were checked for local regressions.
- Read `AGENTS.md`, `unslop`, `pr-review`, and TypeScript guidance. No delegation, source edits or commits. This report is the only repository file written by the reviewer.
- Source was changing during review. For example, the Worker body cap changed from 8 MiB to 24 MiB; the earlier mismatch is therefore excluded from findings. This report is a snapshot, not acceptance of subsequent edits.

## 1. P1: interrupted suspension is excluded from recovery and loses its alarm

Location: `apps/cloud/src/scheduler.ts:106`, `apps/cloud/src/scheduler.ts:124`, `apps/cloud/src/scheduler.ts:196`.

`activateDurable` commits suspension before releasing ownership. A process loss or release failure between those operations leaves a suspended run with an owner token. The scheduler only selects suspended runs where `owner_token IS NULL`, and its next-alarm query applies the same exclusion. It never reaches the recovery code in `host/durable.ts:67`, even after the old lease expires. With no other work, the recovery tick deletes its alarm.

Impact: a due sleep or expiring wait remains suspended indefinitely after reconstruction. This also happens after a release exception in the same scheduler session; the direct host test for interrupted release does not exercise scheduler selection. Manual resume after lease expiry can recover it, but automatic recovery cannot.

Evidence: an isolated `SqlRunStore` with Bun in-memory SQLite and a storage/alarm adapter was seeded through `createRun`, `claim`, and `suspend`, without `release`. Its heartbeat and wake deadline were both in the past. A scheduler with a new token ran one tick. The result retained `status: "suspended"`, `owner.token: "old"`, and the expired wake deadline, with `alarm: null`.

Smallest fix: include owned suspended runs in recovery selection and alarm calculation. Preserve a fresh foreign lease, schedule its expiry, then reclaim through the store. Recover interrupted indefinite waits as well as due sleeps. Do not require an already released owner before considering recovery.

Missing assertions:

- Inject failure immediately after committing `suspend_run`, before ownership release, then reconstruct the scheduler with a new token.
- Assert the next alarm covers the foreign lease expiry, the due sleep eventually finishes, and ownership clears.
- Repeat with the same session and with an indefinite hook wait. Assert one durable wait record and no repeated external attempt.

## 2. P1: one invalid schedule blocks every run in its workspace

Location: `apps/cloud/src/scheduler.ts:53`, `apps/cloud/src/scheduler.ts:57`, `apps/cloud/src/scheduler.ts:142`, `apps/cloud/src/scheduler.ts:201`.

All due schedules run before candidate activation under one outer catch. A schedule's stored input can become invalid after its definition is saved with a new input schema. Validation then throws before the scheduler processes any runs. The schedule remains enabled and overdue, so every recovery alarm repeats the same error.

Impact: an ordinary definition update can stop unrelated queued work, running receipt reconciliation, heartbeats, sleeps and other schedules throughout that workspace. Existing containers may finish, but the control plane stops consuming their results until someone repairs or disables the offending schedule.

Evidence: an isolated SQL fixture contained a queued run with valid `{ required: "yes" }` input and an overdue enabled schedule whose old `{}` input no longer matched the current graph. After `tick`, the unrelated run remained `queued`, the schedule stayed due, `cloud_scheduler_error` contained `Input does not match the saved graph schema`, and another alarm was set five seconds later. Candidate activation was never reached.

Smallest fix: isolate failures per schedule and continue run reconciliation. Persist the schedule-specific failure. Disable a permanently invalid schedule or give it a bounded retry deadline so an overdue entry cannot cause an immediate-alarm loop. Transient artifact failures should also leave unrelated runs progressing.

Missing assertions:

- Create a valid schedule, save a graph revision with an incompatible input schema, and advance to its next fire time.
- In that same tick, assert an unrelated queued run dispatches, an existing running receipt completes, and another valid schedule fires.
- Assert repeated alarms neither hot-loop on the invalid entry nor duplicate the valid schedule's fire.

## 3. P1: Docker transport errors finish receipts while their containers can still run

Location: `apps/sandbox/src/docker.ts:227`, `apps/sandbox/src/docker.ts:229`, `apps/sandbox/src/attempts.ts:194`, `apps/sandbox/src/attempts.ts:201`.

For a running container, a non-timeout `docker wait` failure throws. `Attempts.launch` converts every backend exception into a terminal `uncertain` result, writes a finished receipt, and removes the operation from its active map. It does not confirm that the container stopped or keep monitoring the saved deadline. A lost acknowledgement from `docker start` has the same risk. Restart only recovers started receipts, so this terminal conversion also prevents restart recovery of that live container.

Impact: the host can fail the graph and release its concurrency slot while the old execution continues changing its run volume. Rescue or cleanup can overlap that execution. The configured outer timeout stops being enforced. `uncertain` correctly prevents repeating that attempt, but it does not prove the worker is dead.

Evidence: an in-memory probe used the real `DockerBackend` and `Attempts.launch` with an injected command runner. Inspect reported an owned running container; `docker wait` returned exit code 1. The resulting calls were only `["container", "wait"]`. The receipt became `finished` with error code `uncertain`, and the active map had size zero. No kill or subsequent reconciliation was scheduled. This probe made no Docker calls and used no receipt files.

Smallest fix: separate unknown container state from confirmed terminal uncertainty. On a transport failure, retain the started receipt and retry reconciliation of the same named container with bounded backoff. Retain deadline enforcement and the host's pending slot. Only publish a terminal receipt after confirming the container is absent/exited or confirming termination of the owned container. Never retry `start` for a started receipt.

Missing assertions:

- Inject a failed `docker wait` transport while inspect reports the container running. Assert the public receipt stays started and the deadline remains monitored.
- Restore Docker access, advance beyond the saved deadline, and assert only the owned container is killed and then receives one terminal result.
- Inject a successful Docker start with a lost CLI response. Assert recovery joins that container rather than terminalizing it while live or starting another one.
- Reconstruct the service between these stages and assert the same attempt remains recoverable and consumes its run slot.

## 4. P2: accepted definitions can exhaust the aggregate list budget and disable single-run operations

Location: `apps/cloud/src/artifacts.ts:78`, `apps/cloud/src/artifacts.ts:83`, `packages/loopy/src/service/service.ts:178`, `packages/loopy/src/service/service.ts:269`, `packages/loopy/src/service/service.ts:321`.

Publication permits up to 1,000 definitions with graphs up to 1 MiB each. Listing has a separate 32 MiB aggregate graph budget. The shared service uses a full registry list to start one slug, find schedule targets, and resolve run descriptions. Once accepted definitions exceed the list budget, unrelated single-definition operations fail even though their requested graph is valid and readable.

Impact: saving enough individually valid definitions can make run creation, schedule mutations, run views and event delivery fail for the workspace. Changing just `startRun` to use `get` is insufficient because its returned run view also lists the registry.

Evidence: an isolated SQL registry with an in-memory R2 adapter accepted 43 definitions with 800,000-character descriptions. Each graph and request fit the configured per-item limits. `registry.get("definition-0")` succeeded. `service.startRun("definition-0", {}, "test")` failed with `Artifact exceeds its 741279 byte limit`; no run was created. The shrinking number is the remaining aggregate list budget, not a violation by that individual graph.

Smallest fix: avoid full registry lists for slug lookup and run-summary resolution. Give listing a bounded summary/pagination path. Alternatively, enforce an explicit aggregate workspace capacity before publishing a definition so successfully accepted state remains readable. Keep the existing memory bound.

Missing assertions:

- Publish valid definitions whose combined current graphs exceed 32 MiB, while each remains below 1 MiB and count remains below 1,000.
- Assert starting and inspecting an individual run, schedule mutation and SSE delivery still work, or assert the capacity-crossing save fails atomically before publication.
- Assert the listing path remains bounded and has an actionable capacity/pagination response.

## Rate-budget observation requiring an explicit invariant

`host/durable-work.ts:92` acquires quota before provider admission at line 113. A provider failure before creating any receipt leaves that acquisition charged. A probe with limit `1 / 1m` and a provider that always returned `none` from lookup and threw before admission called start once; the second activation persisted the same attempt as `rate_limited` for the remaining minute. This is conservative consumption, not evidence of quota overspending or repeated side effects.

Add an assertion that defines whether the budget counts admission requests or admitted executions. If executions are intended, persist an idempotent reservation tied to execution key and attempt so reconstruction cannot repeatedly charge an unadmitted attempt. The existing SQL acquisition transaction prevents a lost-update increment race, and workspace serialization prevents concurrent app turns, but neither establishes accounting across the provider boundary. I am not treating this policy ambiguity as a fifth blocker.

## Verification and limits

Commands run:

```sh
bun --no-env-file test packages/loopy/_tests_/cloud-durable-host.test.ts packages/loopy/_tests_/cloud-service.test.ts
```

Result: 19 passed, 0 failed, 93 assertions.

```sh
bun --no-env-file test packages/loopy/_tests_/service.test.ts packages/loopy/_tests_/service-input.test.ts packages/loopy/_tests_/store.test.ts packages/loopy/_tests_/store-durability.test.ts
```

Result: 51 passed, 0 failed, 246 assertions. These cover local input validation, schedules, revision pinning, durable transactions, rate windows and ownership. They establish no local regression in those tested paths.

```sh
env -u LOOPY_SANDBOX_DOCKER_CONTEXT bun --no-env-file test packages/loopy/_tests_/cloud-sandbox.test.ts
```

Result: 10 passed, 1 real-Docker test skipped, 0 failed, 77 assertions. The tests use isolated temporary roots and synthetic providers. An isolated loopback test server was created and cleaned up by that suite; the parent's running services were not touched.

Five additional `bun --no-env-file --eval` probes exercised interrupted suspension, invalid-schedule isolation, a Docker wait transport failure, pre-admission quota consumption and aggregate R2 listing capacity. They used in-memory SQL, storage, receipt or command-runner adapters and produced the results above. No probe contacted Docker, Wrangler, a live cloud service or personal `~/.loopy`.

No whole `check`, real Docker execution, new Wrangler runtime, cloud operation, existing-service restart or personal-state access was performed. The parent owns real end-to-end verification. Newly integrated `cloud-worker.test.ts` and its real workerd SQL/R2 assertions were read but not run by this reviewer. No tests were added, deleted or moved by the reviewer.

Worker credential routing, workspace-header replacement, workspace-scoped R2 keys, SQL transaction fencing and immutable artifact writes did not reveal an additional concrete tenant leak during this review. This is a source-level conclusion, not independent end-to-end isolation acceptance.

Relevant source fingerprints at the final read:

```text
c654f29adbe62188708c87f04a23ca011f8c9fd92217012cec5a23bf5278d06f  apps/cloud/src/scheduler.ts
5562425de364b7251d3c15c5ab9fcfe4672a9eb1cef5d964609b836bb3001f0f  apps/cloud/src/artifacts.ts
01abfa599968ac15c91074aeb1bcf3099761a904333e419335bf08a38b112ee8  apps/sandbox/src/attempts.ts
e9e99f67829d0bbc818985084af992b3550d58d50c4e796fb9ac4212c0a7502f  apps/sandbox/src/docker.ts
d57a3dc5af95d578781ce521df82da003ad9fcdea1323e6fe95f6626590f307e  packages/loopy/src/service/service.ts
```
