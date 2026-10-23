---
title: Independent sandbox authority implementation review
status: changes requested, one P2 shutdown finding
reviewed-on: 2026-10-23
branch: cloud-integration
base: 6ffecdfd60e16aaa335467684d918b3cd8b44813
head: 6ffecdfd60e16aaa335467684d918b3cd8b44813
head-tree: c88beff6f5e91c8a4618f77343c959afcfc90cf2
---

## Verdict

Changes requested for one reproduced P2 shutdown deadlock. The admission, immutable-result and export authority paths passed the focused suites and additional cross-adapter probes. Those results do not clear the shutdown finding or establish Docker/workload acceptance.

This lane is a major feature, the shared sandbox authority and its filesystem and DO/R2 implementations. Other implementation lanes in this checkout are outside this review. Source was reviewed as an uncommitted candidate over the base above, not as a committed tree. The reverse commit log is empty because HEAD equals base.

## Finding

### P2. Abort admission reconciliation before awaiting HTTP shutdown

Location: `apps/sandbox/src/server.ts:190-192`. Causal path: `attempt-reconciliation.ts:19-30`, `attempts.ts:182-191`, and the SIGTERM/SIGINT caller in `index.ts:41-50`.

A committed admission with a lost acknowledgement enters `resolveAdmissionRead`. If the resolving authority reads remain unavailable, that handler retries until the bridge's stopping signal aborts. `startSandbox.close()` first awaits `server.stop(true)`. Actual Bun 1.4.0 waits for the outstanding asynchronous handler here, even though active connections are being closed. The call to `attempts.close()`, which aborts that handler, is after the wait. The handler and shutdown therefore wait on each other for the duration of the storage outage.

The process retains `service.lock`, so the normal signal shutdown path cannot release ownership for a successor. Authority recovery or a forced process termination breaks the cycle. This does not permit a second start, but it defeats the new shutdown contract precisely during admission recovery. The server-stop ordering predates this change; the new persistent reconciliation loop makes that ordering unsafe for liveness.

Reproduction used the production `startSandbox`, a real ephemeral Bun HTTP listener, a real filesystem authority, and an injected transport fault. The fault committed admission, dropped its reply, then kept reads unavailable. No Docker or shared service was used. After 1,200 ms, the public `close()` was still pending and the root lock still existed. Calling `attempts.close()` separately immediately let the original shutdown finish. A second run initiated `server.stop(true)`, called `attempts.close()` before awaiting the stop promise, and closed in 5.45 ms with the lock absent. The read outage remained in place in both runs.

Smallest fix: initiate HTTP stop and bridge close before awaiting the HTTP stop promise. For example, retain the stop promise, await `attempts.close()`, then await the retained promise. Preserve the bridge's existing admission-settle, monitor/artifact drain, dependency close and last-lock-release ordering. No authority contract change is needed.

Exact missing assertion: call the returned `startSandbox(...).close()` while a real POST handler is reconciling a lost admission acknowledgement and all resolving reads remain unavailable. Assert that close and the handler settle within a bounded interval without storage recovery, no backend start occurs, and the lock is released. Reopen the same isolated root and assert that its persisted old-session admission only recovers. Calling `Attempts.close()` directly, as the current lifecycle test does, cannot catch the server wrapper's ordering defect.

Evidence: `.loopy/architecture-tests/sandbox-review-929eedd019/server-shutdown.test.ts` and `server-shutdown.log`. The command exits 1 with one expected finding reproduction failure and one passing candidate-order control. Production source was not changed to test the control.

## Pin and scope

The 56-file SHA-256 inventory is `.loopy/architecture-tests/sandbox-review-929eedd019/source-manifest.json`, SHA-256 `6e5600b8124c792ce860f56cc72aafdbdb704a2004b4ddd2b4f2d4259a8f0268`. Every inventory hash was checked again after the probes. All 56 matched. The inventory includes the sandbox source, receipt DO source/configuration, shared journal contracts/exports and focused boundary tests/fixtures. Its candidate delta against base is 4,713 lines added and 294 deleted, including untracked files.

Relevant finding hashes:

```text
64d6a3798d5ed5a68084e03e23c58bbbd4a5b7236f507ea0854b5595b37ef8f3  apps/sandbox/src/server.ts
a774feb9b96a8abcd75afc0b43ccf3aa4b76e2e2d1254dedbfbe275e154bd9fa  apps/sandbox/src/attempt-reconciliation.ts
```

`apps/sandbox/src/attempts.ts` is `a8bffa4bc58d35daf48e0b6e38bf2dbb975e54ccf3421a8d024b3d32edadeee1`. The manifest is the complete machine-readable pin.

Read the repository AGENTS instructions, unslop, PR review, TypeScript and worktree guidance, and the requested proposal, Fable review and both implementation notes. Inspected both journal contracts, the sandbox lifecycle/persistence/admission/result/HTTP and Docker/helper code, receipt authority/SQL/results/route/identity code, typed HTTP client, Worker/environment/Wrangler delta and boundary suites. The reference model imports no production transition implementation. This review reused that model as an independent oracle, then exercised more outgoing transitions than the implementation suite's shortest-state traces alone.

## Contract assessment

- Admission identity includes the configured root, workspace, complete execution key with ordered scopes and attempt. Both authorities validate derived Docker names and run volume identity. The bridge hashes the complete request using canonical JSON, sorting bundle descriptors. A duplicate preserves the first plan, deadline and admitting session. Changed content conflicts before backend start.
- The corrected B1 path survives an unavailable resolving read with bounded backoff. An absent resolving read can precede a delayed commit. The retained request/hash survives that absence, and a later lookup can supply it to the same-session, unissued gate. The issued marker is set before invoking start. The additional probes checked changed-body rejection between the delayed commit and matching lookup, exactly one same-session start, and zero starts after bridge restart, on both adapters.
- Request bodies remain retained while an ambiguous null-read admission is unresolved. Observing a record clears the retained entry, and recovery clears it before monitoring. Issued IDs remain for the process lifetime. There is no timer eviction of unresolved requests, which would discard the late-commit start obligation. Progress after a successful absent read depends on another delivered lookup/start. This is an explicit lifetime limit, not a background-reconciliation claim.
- Only an authoritative started record enters the monitor map. The map suppresses reads while the monitor is executing or publishing. Twenty monitored lookups per adapter performed zero authority reads in the added probe. Terminal results are exposed after authoritative pointer publication and byte resolution. The monitor retains its observed result through byte/pointer failures and lost completion acknowledgements without another backend recovery read.
- Filesystem completion verifies workspace-bound immutable bytes before atomic pointer rename. File and directory fsyncs precede publication. DO completion verifies R2 bytes outside SQL, then rechecks session, request hash and existing terminal state inside `transactionSync`. A successor may complete an old admission, preserving its original session. Different terminal digests cannot replace a winner. Blob loss remains a failure and never becomes receipt absence.
- The bridge bounds serialized terminal results. R2 hashes canonical bytes server-side, caps them at 2 MiB, conditionally creates workspace/namespace-scoped objects and verifies collisions. Both readers verify digest and length. R2 also uses fatal UTF-8 decoding and schema parsing. The filesystem result writer throws for oversized direct input; the bridge normalizes it before this writer. R2 additionally normalizes oversized direct puts. These entry-point differences do not let the bridge publish an oversized result.
- Export grants precede helper creation and block new same-volume admission and competing exports. The live-token set prevents reconciliation from removing an in-flight export. Failed cleanup preserves exclusion. Recovery releases a previous session's guard through the current caller session only after helper cleanup succeeds. Released tokens cannot be re-granted, and releasing an older token does not clear a newer guard. Filesystem release writes the tombstone before unlinking the active guard, so interruption conservatively retains exclusion for later cleanup.
- Helper cleanup checks the exact name and owner/request/role labels, removes it and checks exact-name absence. The command-runner test covers wrong owner and unconfirmed removal. SQL cannot verify that Docker observation. This review does not promote a label-check fixture into proof against delayed Docker daemon operations.
- The root lock is acquired before dependency/session construction. Successful `Attempts.close()` aborts admissions before settling them and draining monitors/artifact requests, then closes dependencies and releases the lock last. The public server wrapper has the finding above. The filesystem epoch remains local and constant under this lock; only DO sessions provide persistent CAS and nonce history.
- DO mutations use synchronous transactions with no awaited I/O inside them. Current tests actually execute workerd rollback and full runtime reconstruction over fresh persistent SQL/R2 storage. Recovery uses `kind='started' AND id>?` plus an active-token seek query in one transaction. The rerun confirmed the covering `receipt_attempt_recovery`, covering partial `receipt_export_recovery`, and partial `receipt_export_volume` plans against terminal/released history. This establishes access paths, not latency or asymptotic cost for every caller. Filesystem recovery scans retained files; bridge export reconciliation also collects recovery pages.
- The Worker keeps the route local, loopback-only and separate from principal routing, checks Origin and namespace, bounds input and requires a distinct bridge credential. The HTTP adapter rejects redirects, uses a five-second request deadline and parses operation-specific response schemas. Wrangler appends the receipt class migration and R2 binding without changing the Workspace migration or adding credential/root defaults.

One observable adapter difference remains: releasing a foreign unknown token is a filesystem no-op, while DO returns `AuthorityError('missing')`. Both leave all guards intact. The independent replay normalized only that missing-token outcome to no mutation, consistent with Fable's foreign-token requirement. Known-token release, stale-session rejection, released-token replay and guard state were checked without that normalization. The current bridge releases discovered persisted tokens, so this difference is not a demonstrated source defect in its caller.

## Verification

All runs used fresh storage. Filesystem temporary roots were redirected under this review's unique directory using TMPDIR. Miniflare fixtures created their own fresh unique architecture-test directories and disposed them. No source mutations or negative-control mutations were performed.

```sh
TMPDIR="$PWD/.loopy/architecture-tests/sandbox-review-929eedd019/tmp" bun test --timeout 60000 packages/loopy/_tests_/sandbox-authority*.test.ts packages/loopy/_tests_/cloud-receipt*.test.ts packages/loopy/_tests_/cloud-sandbox.test.ts
```

Exit 0. `46 pass`, `1 skip`, `0 fail`, `1586 expect() calls`, 12 files. The skipped test is the pre-existing opt-in real-Docker test. The filesystem model printed depth 7, 56 states, 702 explored transitions and 55 shortest representative traces. Workerd tests passed rollback, lost-response reconstruction, R2 integrity/isolation/publication and query-plan assertions.

```sh
TMPDIR="$PWD/.loopy/architecture-tests/sandbox-review-929eedd019/tmp" bun test --timeout 60000 ./.loopy/architecture-tests/sandbox-review-929eedd019/cross-adapter.test.ts
```

Exit 0. `8 pass`, `0 fail`, `13458 expect() calls`. Per adapter, all 56 reference-model states received each of the 13 outgoing actions by replaying 728 representative paths, including rejected and idempotent self-loops. Each adapter applied 3,424 non-skipped actions. Final receipt kinds and terminal result bytes were compared to the model. The three bridge scenarios per adapter also checked dropped admission/completion replies, temporary read failures, delayed commit after null, changed content and cross-session recovery. DO paths used the production Worker, typed HTTP adapter and real local workerd SQLite/R2, with an injected backend instead of Docker. The fault wrapper drops replies after actual operations; it does not simulate process death or network cancellation. Existing HTTP proxy tests separately drop real HTTP responses.

```sh
TMPDIR="$PWD/.loopy/architecture-tests/sandbox-review-929eedd019/tmp" bun test ./.loopy/architecture-tests/sandbox-review-929eedd019/server-shutdown.test.ts
```

Exit 1. `1 pass`, `1 fail`, `4 expect() calls`. Current order failed with `status=stuck, lockHeld=true`; candidate concurrent initiation passed with `status=closed, lockHeld=false`. Both fixtures were explicitly drained and removed after observation. Logs are retained beside the review-only tests.

Focused `git diff --check` on sandbox source, receipt source, Worker/environment/Wrangler and journal contracts exited 0 without output. The final manifest verification printed `all 56 pinned files unchanged`. No full check, build gate, production semantic typecheck or lint run was added by this reviewer. Existing tests were neither deleted nor moved.

## Live proof limits and handoff

The one source defect above needs correction and the affected server lifecycle test must pass before this lane is accepted. The other unperformed gates remain with root, rather than being reported as additional defects:

- Actual Docker create/start/wait/kill/restart and helper absence under delayed daemon operations. The added backend and cleanup fixtures do not establish provider fencing, worker lifetime during monitor outage or arbitrary external-effect uniqueness.
- Actual durable factory/launcher selection and populated-filesystem-root refusal. The sandbox test named for this boundary injects a factory that throws; it proves construction occurs under the lock, not that a real durable factory refuses existing receipts. The requested notes assign the actual selection/refusal implementation to root. There is no automatic fallback in the reviewed adapters.
- Fresh repeated 525 cloud and 45 daemon workloads, receipt/result identity reconciliation, real R2 usage by the workload, performance attribution and final independent workload evidence review.
- Repository-wide `bun run check` and integration on main. Neither is owned or authorized in this review.

Local workerd tests do not establish remote Cloudflare replication or power-loss guarantees. Filesystem fsync ordering is source-backed and exercised locally, not a physical power-failure test. Recovery cursors enumerate current recoverable state, not a cross-page historical snapshot. Finite model coverage is limited to two session roles, three identities, two terminal results and one guard token. Separate authority tests exercise old/new guard tokens, but the model is not an unbounded concurrency proof.

Only this requested report was written outside the unique review-probe directory. No source edits, commits, children, main changes, cloud provisioning, Docker launches, shared-service changes, existing workload-state reads or credential access occurred.
