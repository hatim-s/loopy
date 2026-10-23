---
title: Independent sandbox authority review, round 2
status: approved within reviewed scope, prior P2 resolved
reviewed-on: 2026-10-23
branch: cloud-integration
base: 6ffecdfd60e16aaa335467684d918b3cd8b44813
head: 6ffecdfd60e16aaa335467684d918b3cd8b44813
head-tree: c88beff6f5e91c8a4618f77343c959afcfc90cf2
---

## Verdict

Approve this round. The public-server shutdown fix resolves the reproduced P2 without moving lock release ahead of bridge drain. No new concrete finding in the reviewed change. This clears the source finding from `sandbox-review-1.md`; live acceptance and final integration remain with root.

The authority lane is a major feature. This follow-up is one minor bug fix within that feature. The reviewed candidate is dirty over the HEAD above, not a committed tree. Base equals HEAD, so the reverse commit log is empty. Other implementation lanes were not reviewed.

## Causal assessment

At `apps/sandbox/src/server.ts:190-193`, close now retains the promise from `server.stop(true)`, immediately invokes and awaits `attempts.close()`, then awaits HTTP shutdown. Previously the HTTP shutdown wait prevented the admission abort from running while an outstanding POST handler retried unavailable authority reads. The new order breaks that cycle.

`Attempts.close()` still shares one shutdown promise. Its unchanged shutdown at `attempts.ts:182-191` aborts admissions, settles admission gates, drains monitors, waits for artifact operations, closes dependencies, then releases the root lock. Admission recovery and monitor launch check the abort signal. The wrapper change introduces no authority/session operation and no alternate unlock path.

The three new tests call production `startSandbox` with actual ephemeral Bun HTTP listeners and injected backend/authority behavior:

- The outage case commits admission, loses its acknowledgement, and leaves resolving reads unavailable. Public close and the HTTP request settle within the 750 ms bound while the outage remains active. No backend start occurs; dependency close runs once and the lock disappears. A successor over that same isolated root performs one recovery and zero starts, returning the uncertain result.
- The effect case holds the backend operation open. Shutdown rejects a new admission and retains the lock through the held operation and a separately held dependency close.
- The artifact case enters through HTTP and holds helper cleanup open. The lock remains held through that cleanup and dependency close. It is absent after public close resolves.

The first test's direct `Attempts.close()` call is failure teardown after the bounded public-close assertion, so it cannot make the assertion pass. These tests address both the original deadlock and the unsafe early-unlock alternative. They establish ordering with injected promises, not actual Docker helper or worker lifetime.

## Pins and delta

Evidence directory: `.loopy/architecture-tests/sandbox-review-2-654a03f6bf/`.

The current 57-file source/test inventory is `source-manifest.json`, SHA-256 `b5f3771683233d724ee19dc8637d1159d674b31b1f2ee7a0a6d5af7cab2a5477`. It covers sandbox source, DO/R2 receipt source/configuration, shared journal contracts/exports, and their focused tests/fixtures. All 57 hashes matched again after verification. `pin.json` records branch, HEAD, tree, empty reverse log and tracked deltas.

All 49 file hashes listed across the two implementation notes match the current files. Exact comparisons are in `implementation-pin-comparison.json`. This verifies those documented pins; it does not turn the earlier review's tests into new executions.

```text
7009a9e6cad6f7844e3de6d26db3edee2a25b4167db8bb61090682045482f985  apps/sandbox/src/server.ts
1de5c5d4436e686788427d2ef63494abdcf29e783ef548ca8223de894f24f848  packages/loopy/_tests_/sandbox-authority-shutdown.test.ts
a8bffa4bc58d35daf48e0b6e38bf2dbb975e54ccf3421a8d024b3d32edadeee1  apps/sandbox/src/attempts.ts
a774feb9b96a8abcd75afc0b43ccf3aa4b76e2e2d1254dedbfbe275e154bd9fa  apps/sandbox/src/attempt-reconciliation.ts
```

Reversing only the close-order edit in memory reconstructs round 1's exact server SHA-256, `64d6a3798d5ed5a68084e03e23c58bbbd4a5b7236f507ea0854b5595b37ef8f3`. `round-2-server.diff` records that comparison. Runtime delta from round 1 is two lines added and one deleted. The new test adds 230 lines, for 232 added and one deleted overall. No test was deleted or moved. No other behavior change belongs to this follow-up.

## Verification

Read the supplied and repository AGENTS instructions, unslop, PR-review, TypeScript craft and pattern reference, worktree guidance, proposal, Fable round 1, sandbox round 1 and both implementation notes. Inspected the fixed server range and its admission, reconciliation, monitor, export and lock lifecycle callers. Bun reports `1.4.0`.

Exact test commands, both exit 0:

```sh
env -u LOOPY_SANDBOX_DOCKER_CONTEXT TMPDIR="$PWD/.loopy/architecture-tests/sandbox-review-2-654a03f6bf/tmp" bun --no-env-file test --timeout 60000 packages/loopy/_tests_/sandbox-authority-shutdown.test.ts > .loopy/architecture-tests/sandbox-review-2-654a03f6bf/shutdown.log 2>&1
env -u LOOPY_SANDBOX_DOCKER_CONTEXT TMPDIR="$PWD/.loopy/architecture-tests/sandbox-review-2-654a03f6bf/tmp" bun --no-env-file test --timeout 60000 packages/loopy/_tests_/cloud-sandbox.test.ts packages/loopy/_tests_/sandbox-authority*.test.ts > .loopy/architecture-tests/sandbox-review-2-654a03f6bf/focused.log 2>&1
```

The targeted run printed `3 pass`, `0 fail`, `24 expect() calls`. The focused suite printed `31 pass`, `1 skip`, `0 fail`, `1511 expect() calls`, across eight files. The skip is the existing opt-in real-Docker test, explicitly disabled for this review. The model printed depth 7, 56 states, 702 transitions and 55 filesystem traces.

```sh
git diff --check -- apps/sandbox/src apps/cloud/src/receipts*.ts apps/cloud/src/environment.ts apps/cloud/src/worker.ts apps/cloud/wrangler.jsonc packages/loopy/src/contract/sandbox-journal*.ts packages/loopy/src/contract/index.ts packages/loopy/_tests_/sandbox-authority*.test.ts packages/loopy/_tests_/cloud-sandbox.test.ts
```

Exit 0, no output. Hash verification printed `implementation inventory matches: 49 / 49` and `all 57 pinned source/test files unchanged`.

The implementation note reports failed sequential-shutdown and premature-unlock negative controls followed by source restoration. I inspected their described assertions and verified the restored source hashes, but did not rerun mutations or read their old evidence directories. No production source was edited in this review.

## Limits and handoff

The earlier 46-test and eight-probe cross-adapter review remains prior evidence. This round intentionally did not repeat that broad review or execute DO/R2 suites because the correction changes only server shutdown ordering. No claim of new workerd, remote Cloudflare, physical crash, arbitrary external-effect or unbounded concurrency proof follows from these runs.

Root still owns real Docker lifecycle/restart and delayed-operation checks, actual durable factory selection and populated-filesystem-root refusal, fresh cloud/daemon workload acceptance with receipt/result identity evidence, repository-wide checks and final main integration. These are deferred integration gates, not additional source findings.

All review runtime state used a new isolated directory under `.loopy/architecture-tests`; TMPDIR was redirected there and environment-file loading was disabled. Fresh fixture storage was removed after the runs. Only this report was written outside that new evidence directory. No existing workload state, credentials, shared services, OS temporary storage, Docker, cloud resources, main, commits, source edits, full check or delegated work were used.
