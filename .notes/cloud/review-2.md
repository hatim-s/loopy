# Phase 1 independent review, round 2

Verdict: no blocking code findings in the reviewed snapshot. The four round-1 blockers have causal fixes, and the new artifact export did not reveal an additional trust-boundary or live-execution defect. This is a Phase 1 source-review verdict. It does not authorize deployment, a main merge, or replace the parent's final check and acceptance work.

## Scope and snapshot

- Checkout `/Users/hatim.shakir/projects/loopy/cloud-integration`, branch `cloud-integration`.
- HEAD and comparison base `dee31da64781c04313b2555a5e697da724e06ef8`. All implementation changes remain uncommitted.
- Final source inspection on 2026-10-22 at approximately 16:52 UTC. Tracked diff: 30 files, 604 lines added and 1,397 deleted. New cloud/sandbox apps, shared service, portable store, durable host, tests and scripts were also reviewed; Git's tracked diff statistics exclude those files.
- Classification: major feature. Shared service, HTTP/SSE, validation and SQL-driver extractions support the cloud integration and preserve the local adapters.
- Read the checkout's `AGENTS.md`, the supplied user instructions, `unslop`, `pr-review`, TypeScript guidance and patterns, worktree guidance, and `.notes/cloud/review-1.md`.
- Reviewed implementation source and relevant existing owners, including reducer control traversal, store effects, ownership, schedule transactions, local service/registry behavior and execution capture. Test success alone is not the basis for the verdict.
- No delegation, source edits, commits, remote cloud operations, personal runtime-state reads, existing-stack requests, restarts or Docker operations. The only persistent review artifact written is this file. Tests used isolated temporary state and their own processes. Ports 14870 through 14873 and 14970/14971/14973 were not targeted.

## Prior blockers

1. **Interrupted suspension recovery is fixed.** `apps/cloud/src/scheduler.ts:72` selects owned suspended runs independently of available execution slots. Fresh foreign leases retain ownership until their recorded expiry; expired and same-session suspensions release ownership without replaying the graph. Owned suspensions also participate in next-alarm calculation. The scheduler tests exercise fresh/expired foreign owners and the same token across due sleep, future sleep and indefinite wait, repeated release failure, and recovery while all execution slots are occupied. Those 16 tests passed in this review.

2. **Schedule failures are isolated.** `apps/cloud/src/scheduler-schedules.ts:47` catches each schedule's failure. Invalid revised input disables that schedule; transient failures persist a five-second retry deadline keyed to its version. Selection excludes deferred failures, allowing a full failing batch to yield to later schedules. Healthy run reconciliation continues after schedule processing. Tests cover unrelated queued/running work, healthy schedules, failures before and after fire commit, duplicate-fire prevention and a full batch of failures. The schedule pointer and run still commit together through the shared store transaction.

3. **Docker transport errors retain live work.** `apps/sandbox/src/attempts.ts:222` leaves the receipt started and retries `recover` with bounded backoff. It never retries `start`. `apps/sandbox/src/docker.ts:223` inspects the pinned container and ownership labels; deadline handling at line 205 confirms termination before returning a terminal timeout. Recovery removes and confirms removal of a never-started container to fence a lost start acknowledgement. The synthetic Docker tests passed for lost acknowledgement, failed wait, service reconstruction, retained started receipts, original-container recovery and deadline kill. This reviewer did not repeat the parent's real-Docker execution.

4. **Aggregate graph capacity is enforced before publication.** `apps/cloud/src/artifacts.ts:195` measures current graph sizes and performs a preliminary check. Lines 208 through 237 recheck generation, source ownership, count and aggregate byte capacity inside the pointer transaction, after immutable R2 writes complete. `apps/cloud/src/artifacts-capacity.ts:52` counts each current definition, excluding the replaced slug. Reconstructed size metadata is measured before publication, and the final transaction fails closed if another pointer lacks size metadata. Real local workerd/R2 tests passed for capacity-crossing new saves and replacements, old-pointer preservation, replacement with a smaller graph, subsequent service/SSE readability and concurrent contenders for the last capacity. Accepted current graphs remain within the list budget.

## New artifact export and retained invariants

- `apps/cloud/src/worker.ts` authenticates before selecting the workspace object and replaces the workspace header. The object checks its persisted workspace identity. R2 keys and provider requests derive workspace identity from that trusted selection. Spoofed query/body/header workspace and cross-tenant run, hook, log, event and source reads were exercised by the real local Worker tests.
- `apps/cloud/src/artifact-route.ts:35` requires an existing run in the authenticated workspace and terminal run status before contacting the provider. An arbitrary key or attempt does not supply a volume name. The provider's receipt lookup derives the volume from the exact workspace/execution-key/attempt identity.
- `apps/sandbox/src/attempts.ts:196` requires a finished receipt, fences new same-run admission, waits for already admitted requests and rejects pending receipts on the volume. `apps/sandbox/src/artifacts.ts:95` additionally rejects running, restarting or paused mounted containers before creating the read-only helper. Thus a terminal-looking host record alone cannot bypass provider live-work checks.
- `apps/sandbox/src/artifact-worker.ts` walks held directory descriptors with `O_NOFOLLOW`, requires a regular file, bounds the actual read to 1 MiB plus one byte and checks metadata after reading. The helper has no network, capabilities, host mounts or credentials. Provider-side validation verifies path, decoded size, canonical base64 and SHA-256. Export is documented as the current run workspace, not an immutable per-attempt snapshot.
- Durable activation persists reducer effects before provider admission. Lookup precedes every start; started receipts are reconciled rather than repeated. Owner tokens and execution key/attempt checks fence persisted results. Retry/rate-limit deadlines retain the running slot; waits and sleeps release it.
- An additional in-memory activation probe used a permanent failure in one parallel branch, a live sibling and outer finally cleanup. The first activation retained run ownership and status `running`, started the two branches once and did not start cleanup. Only after completing the live sibling did cleanup start once. No external provider or filesystem state was involved.
- SSE reads and retention preserve complete transaction boundaries. The shared extraction retains local SQLite data-version polling and uses store subscriptions for the Durable Object. Real workerd rollback and stale-owner tests passed without leaked outbox events.
- `.github/workflows/ci.yml` is unchanged from the base and only installs/checks the project. No new remotely deploying CI was added. The new development launchers use explicit local Wrangler mode and worktree state; the Worker rejects nonlocal stage/host configuration, and the sandbox provider requires a loopback HTTP endpoint. Execution containers have no personal-home or Docker-socket mount. The host Docker client uses the explicit context, which legitimately requires host Docker configuration; that configuration is not injected into executions.

## Nonblocking follow-up

The conservative rate-budget behavior from round 1 still needs an explicit operational invariant. `packages/loopy/src/host/durable-work.ts:92` acquires quota before provider admission at line 113. A failure before receipt creation can therefore consume quota without an admitted execution. This does not overspend quota or repeat a started effect, so it is not a correctness blocker under the stated conservative policy.

Smallest follow-up: document that this budget counts admission attempts, including failures before receipt creation. Add one assertion where limit is `1 / 1m`, lookup remains `none`, and start throws before creating a receipt. The next activation should retain the same attempt, persist rate limitation, retain ownership and avoid another start until the window opens. The current documentation and new tests do not state that policy explicitly. If the intended budget instead counts admitted executions, this requires an idempotent persisted reservation rather than documentation alone.

No blocker entry with an impact/fix/missing-assertion tuple remains. The item above is a policy/documentation follow-up, not a fifth blocker.

## Verification

Commands run, with no source or test edits:

```sh
env -u LOOPY_SANDBOX_DOCKER_CONTEXT bun --no-env-file test packages/loopy/_tests_/cloud-scheduler.test.ts packages/loopy/_tests_/cloud-durable-host.test.ts packages/loopy/_tests_/cloud-service.test.ts packages/loopy/_tests_/cloud-sql-driver.test.ts packages/loopy/_tests_/cloud-sandbox.test.ts
```

Result: 81 passed, 1 skipped, 1 failed, 605 assertions. The real-Docker test was deliberately skipped. The sole failure was `memory row retention keeps the stricter cap when an older event also expires`, which took 15.95 seconds and exceeded Bun's default five-second test timeout. It was not an assertion failure.

```sh
bun --no-env-file test packages/loopy/_tests_/cloud-sql-driver.test.ts --test-name-pattern 'memory row retention keeps the stricter cap' --timeout 30000
```

Result: 1 passed, 34 filtered out, 0 failed, 2 assertions. The same retention test took 16.19 seconds. The repository's standard `bun run test` already uses a 60-second timeout. This result does not establish a performance regression in pruning; the test also creates 99,999 heartbeat transactions.

```sh
bun --no-env-file test --timeout 60000 packages/loopy/_tests_/cloud-artifacts.test.ts packages/loopy/_tests_/cloud-worker.test.ts
```

Result: 19 passed, 0 failed, 206 assertions, 41.40 seconds. These instantiate isolated local Miniflare/workerd, SQLite and R2, with no remote resources or existing-stack access.

One additional `bun --no-env-file --eval` in-memory probe produced:

```json
{"failedSiblingRetainsRunningSlot":true,"cleanupBeforeLiveCompletion":0,"cleanupAfterLiveCompletion":1,"starts":["failed","live","cleanup"]}
```

No full `bun run check`, real-Docker run, parent failure journey or dashboard browser acceptance was repeated here. No tests were added, deleted or moved by this reviewer. The parent still owns final frozen-source checks and end-to-end acceptance. Local emulation does not establish remote Cloudflare or provider behavior. Phase 2 still requires explicit approval, and there is no main-merge authorization.

## Source fingerprints

SHA-256 at the final source inspection:

```text
c5df4ce777fc44582d018b3269cc6eb1251fb0fca899173b3a9615f1d277d0bd  apps/cloud/src/scheduler.ts
dfe62c4c3835a534a7de12d65a5038dbdb81cf44cc9077a4b82a0e72930eaeb1  apps/cloud/src/scheduler-schedules.ts
39da95f2a0c0021b1523e0af4c9d772f1deaa213e1062d1880a6435e22134e75  apps/cloud/src/artifacts.ts
ff5e583220fb88e00c017be1dafb44e0a00ed555f817f3762cc0f8ffe33da2b5  apps/cloud/src/artifacts-capacity.ts
c0d35dbfcaf540647d226c77b66df0744e1b2ce215d9579eb93b31bb70132bf7  apps/cloud/src/artifact-route.ts
412073f669819fed8f1bc6b711d093d997ff72f9abe71f39604e99757ccded6d  apps/cloud/src/provider.ts
422cb84d79849b685d06fb74b98c8df79eb0ae034d372412b51c29b1d39f9ace  apps/cloud/src/workspace.ts
0c35824173de6a685409c61d303b81c463056e8d6c755990ffefc35800ac724b  apps/cloud/src/worker.ts
d5da615824d59074e123440f7155d551090195c0b04021d7d8d2ced2245f12ac  apps/sandbox/src/attempts.ts
879d257ccec1c61fb2acddf004ccf29aa97c34bb878e830fc4227278bcfd46be  apps/sandbox/src/docker.ts
35ce25495b615bd6cd9db0f3b04b618c42e84f38aed121a040d00945086f659f  apps/sandbox/src/artifacts.ts
5d58ac0e4e557b23a0a6b782d00a12bed78b1bd2bc5a9883528250702aa77243  apps/sandbox/src/artifact-worker.ts
719b0b16035838d29dba65676427ebad8b4476039ba8e986ccaa62991dcdf7e0  packages/loopy/src/host/durable-wake.ts
d22596e717c3fd6a3c1d46874299cd79fd980052b1c90d31662b58c7eeb3f050  packages/loopy/src/host/durable-work.ts
a7da517375a80ea86411d77177634b35449114180975d00ffc48b31195a548ab  packages/loopy/src/host/durable.ts
d57a3dc5af95d578781ce521df82da003ad9fcdea1323e6fe95f6626590f307e  packages/loopy/src/service/service.ts
3b1b438f829fd837375ca841f8f3ef9ab33b0d06e8e84d5d397712e326239ea4  packages/loopy/src/service/events.ts
```
