---
title: Independent host policy implementation review
status: approved within reviewed scope
date: 2026-10-23
branch: cloud-integration
base: 6ffecdfd60e16aaa335467684d918b3cd8b44813
head: 6ffecdfd60e16aaa335467684d918b3cd8b44813
---

# Verdict

Approve the host-policy lane. No blocking source defect found in the pinned implementation. The shared planner, admission extraction and targeted Store read follow the accepted proposal and Fable corrections. The local retry-slot change is intentional and has causal coverage. This verdict covers this lane's source and focused evidence. It does not complete the parent integration, workload or external-adapter gates.

This is a major refactor with an explicitly accepted local scheduling correction. I read AGENTS.md, the unslop, pr-review and TypeScript skills, proposal.md, fable-review-1.md, host-policy-implementation.md and the relevant assessment detail. I inspected final source, its base diff, the actual cloud caller's serialization, existing boundary tests, the independent oracle and replay implementation. No source, existing test, other lane, main checkout, shared service, Docker resource, cloud resource, credential or existing workload dataset was changed. The only repository document authored is this report. Review probes and fresh SQL files are confined to `.loopy/architecture-tests/host-review-1-1dbx5aat/`.

# Source and causal review

## Planner and admission ordering

`host/activation-plan.ts:15-40` preserves relative order inside the store/work partitions. Dispatch and sample are work; schedule_retry remains both persisted policy and local timer work. Only suspension beside retrying or rate_limited nodes is suppressed. Finished disposition preserves the reducer outcome. Both drivers commit plan.storeEffects before starting work, visibly at `host/activate.ts:47-58` and `host/durable.ts:135-140`. There is no universal driver or fake durable executor left.

The acquired-before-commit race is closed for the initial dispatch batch. Local rate acquisition previously happened while deriving a transition that had not yet committed. Now `ActivationWork.dispatch` runs only after apply resolves. My held-commit probes checked both memory and SQL with both drivers: while apply was blocked, quota acquisitions, receipt lookups and execution starts were all zero. Releasing the commit produced one acquisition and one start, and acquisition observed persisted running attempt 1. Separate rejected-commit probes also observed zero acquisition, lookup and start. Local released ownership; durable retained it, matching their distinct error contracts.

Admission is conservative after that point. `host/rate-limit.ts:29-47` bypasses acquisition when a receipt already exists, charges before requesting a new execution, and does not refund on provider exceptions. The existing durable failure test checks a pre-admission exception consumes the window without incrementing the attempt. My lost-terminal-response probes additionally covered local/durable and memory/SQL: the charge survived the thrown response, reconciliation found the finished receipt, no second charge or execution occurred, attempt remained 1, and exactly one log was committed. This is intentional accounting under uncertainty.

Local admissions are now asynchronous per pending identity. Slow receipt reads can change which parallel branch wins a shared quota relative to lexical effect order. That behavior change is documented in the implementation receipt. It does not reorder reducer traversal or output assembly, and this review makes no promise of deterministic parallel quota winners.

## Retry slots, waits and races

The planner adopts the existing durable retention rule for local activation. Retry or rate denial beside an indefinite wait keeps the run running and owned. The concurrency-one checks hold a retry, leave a second run queued, observe heartbeat renewal beyond the original lease and reject a competing claim. After retry settlement and true suspension, the next run progresses. Sleep deadlines retain their timer work while retry is held. Durable heartbeat-bound wakes remain in `durable-wake.ts`, without a change to its algorithm.

Local reduction reloads all nodes at `activate.ts:41`. Durable commit reloads them at `durable.ts:128`. Provider awaits therefore do not supply the state snapshot for subsequent completion or denial reduction. The directed signal-during-completion and signal-during-denial cases pass. Existing memory/SQL wait-race checks also preserve an accepted signal when a later stale suspension batch commits, including the signal between reload and apply.

The denial-reload race has direct protection beyond the positive signal case. The committed target may advance while lookup or rate admission awaits. A returned denial goes through commit's fresh reload and `engine/step.ts` checks the current running attempt before writing rate_limited. The new denial-fence test mutates during lookup. My memory/SQL probes mutated to attempt 2 inside acquireRateLimit, after the target read and before denial returned. Attempt 2 stayed running, no provider start occurred, and no logs were written. These synthetic same-token writes test the event fence, not permission for general concurrent host writes.

## Completion, logs and targeted reads

`completion-event.ts` preserves success/failure data, identity, attempt, logs and timestamp. `engine/step.ts:12-35` rejects non-running or mismatched-attempt completions before appending any logs. Store batches atomically persist node changes and logs. Source inspection and the existing stale-completion test support that boundary; controlled retry checks keep one log sequence per accepted attempt. My committed-completion/lost-apply-response probes on memory and SQL leave a terminal run after the thrown response, then resume without another start or log and release the retained owner.

This is host reduction idempotence, not arbitrary Store.apply idempotence. Replaying a raw accepted write_log batch can allocate another log index. The implementation does not claim otherwise.

`Store.getNodeRun` uses the full execution key. Memory clones the returned record; SQL reuses readNode's indexed run/key lookup and boundary parser. Missing runs, reversed ordered scopes and different indices do not alias the target. Source confirms nested data detachment. The directed read test mutates the nested scope array through reverse, but replaces output rather than mutating its nested array; that assertion alone would not establish deep output detachment. The actual structuredClone/JSON parsing implementations do establish it.

Stable started-only turns retain two full reads plus B targeted reads. With nine persisted attempts and budget 3, the test observes exactly two full reads, three targeted reads and one reconstruction batch per turn over three turns, covering all nine receipt identities with no additional starts or receipt metadata batches. This proves the read/write count change for that stable path, not an HTTP latency result. The initial reducer reconstruction still clones/traverses and rewrites running nodes.

`host/durable-work.ts:82-87` still writes a previously read node when first recording receipt=started. It is owner-fenced, not a node-attempt compare-and-set. A same-token concurrent writer can be overwritten there. That is an existing, explicitly retained serialization assumption, not a new guarantee from getNodeRun. I checked the production caller: `apps/cloud/src/workspace.ts:102-113,183-186` places request handling and alarm ticks on the same exclusive promise chain; `scheduler.ts:205` awaits activation inside that path. Preserve this condition. Completion/denial fence tests do not prove this metadata write safe under arbitrary concurrent same-token mutations.

## Provider failures and control traversal

Lookup exceptions and start exceptions propagate rather than becoming fabricated completions or receipt absence. Durable retains owner/session state for reconciliation. A lost start response is recovered through the same identity, and a confirmed missing receipt after persisted started knowledge becomes uncertain without automatic retry. Local still drains pending work and releases on failure. These behavior differences remain explicit.

All 16 files under `packages/loopy/src/engine/` are byte-identical to the base. No control traversal, continuation selection, branch ordering, map scope semantics, cleanup/rescue behavior or output pruning was rewritten. The five engine-control-unwind checks passed, including started-item cleanup before outer cleanup, cancellation reconstruction, rescue precedence and sleep progress beside running work. Planner partitioning changes host disposition, not the reducer's lexical traversal. The base reducer still emits suspension beside retry/wait; the host deliberately filters it.

# Model and causal-control audit

The independent oracle in `host-policy-model.ts` imports no production transition helpers. It predicts allowed actions and resulting run/node/owner/wait/receipt/attempt/log state. Replay goes through real activateDurable, the reducer and Store, and verifies a matching persisted running attempt at every actual provider start. Breadth-first search retains the first trace for each JSON-serialized oracle state and checks every enabled outgoing edge from states below depth 8.

I reproduced exactly 1,652 oracle states and 4,687 checked outgoing transitions per budget, at budgets 1 and 2, with no counterexample. There are 9,374 checked edges across both runs. Five specified traces passed through SqlRunStore and Bun SQLite. SQL uses fresh schema-15 databases and a lease-only owner policy. Those five samples cover lost start response, lookup failure plus disappeared started receipt, retry/signal settlement, interrupted suspension release and stale-owner reconstruction.

The counts are meaningful for the declared small abstraction, with these limits:

- There is one executable identity plus an indefinite wait, two attempts and two owner sessions. The two budgets therefore exercise the same scheduling pressure and produce equal counts. They do not establish wide-graph fairness or two-execution interleavings. The separate nine-identity cursor test provides directed evidence for that case.
- Rate denial, sleep, finite wait timeout, concurrent mutation during a provider await, pre-commit storage failure and stale old-attempt completion are not model actions. Directed tests and this review's probes cover selected cases, outside the enumeration count.
- State deduplication serializes the whole oracle object, not the complete production database and scheduler state. Cursor, nextWakeAt, persisted wake/retry deadlines, run output and wait payload are not independently compared in replay. Cursor is immaterial to selection with one executable identity; timing, wake and payload guarantees still depend on separate assertions. This is bounded trace exploration over an abstraction, not exhaustive production-state exploration or a general liveness proof.
- BFS gives a shortest representative trace within the declared abstraction if a replay fails. Equivalent oracle histories are not all expanded. The error diagnostic wraps that trace. The fixed SQL traces can be longer than eight actions and are not part of the memory state count.

I read `/tmp/loopy-host-negative-controls.py` and its eight saved nonzero test results. They causally remove retry retention, targeted reads, duplicate receipt-write suppression, local fresh reload, missing-started uncertainty, memory detachment, commit-error propagation and durable fresh denial reload. Failures correspond to the expected boundaries, rather than compilation errors. I did not execute the script because it mutates live source, which this review forbids. Its historical executions are evidence supplied by the implementation lane, not eight newly reproduced controls.

One wording limit matters. The commit-error control output fails first on the changed primary error message, before its zero-executor-call assertion. That output alone does not prove the implementation receipt's claim that execution happened without a batch. The mutation permits that path, but the saved test does not reach that assertion. My positive blocked/rejected rate-limited commit probes independently verify the final source's ordering and zero-quota/zero-start behavior. No production correction is required from this distinction.

# Verification record

All test scratch storage used a fresh review root. Existing test mkdtemp calls were redirected there through TMPDIR. No broad check, build, typecheck, linter, service or external-adapter command ran in this review.

```sh
TMPDIR="$PWD/.loopy/architecture-tests/host-review-1-1dbx5aat" bun test packages/loopy/_tests_/host-admission-race.test.ts packages/loopy/_tests_/host-denial-fence.test.ts packages/loopy/_tests_/host-policy-model.test.ts packages/loopy/_tests_/host-slot-retention.test.ts packages/loopy/_tests_/host-targeted-polls.test.ts packages/loopy/_tests_/host-lifecycle.test.ts packages/loopy/_tests_/cloud-durable-host.test.ts packages/loopy/_tests_/wait-race.test.ts packages/loopy/_tests_/engine-control-unwind.test.ts
```

Observed result: 51 pass, 0 fail, 654,974 expect calls, nine files, 3.06 seconds. Model output printed depth=8, states=1652, transitions=4687 and shortest counterexample=none for each budget.

```sh
TMPDIR="$PWD/.loopy/architecture-tests/host-review-1-1dbx5aat" bun test ./.loopy/architecture-tests/host-review-1-1dbx5aat/review-probes.test.ts
```

Final observed result: 16 pass, 0 fail, 76 expect calls, one file, 105 ms. The first 12 probes had also passed separately. An intermediate version of the four lost-response probes incorrectly expected only one final node and failed on the SDK's persisted join node. I corrected the probe to select the finished execution record and reran all 16 with fresh SQL files. No production failure was found or repaired. Probe SHA-256: `306c417894155ce3a29124c573a7e066a7392598e3b193f0b41f5a502fc487b9`.

Read-only source checks included `git rev-parse HEAD`, `git rev-parse 6ffecdf`, `git branch --show-current`, `git log --oneline 6ffecdf..HEAD`, `git diff`, `git diff --numstat`, `rg`, source reads and Python SHA-256 comparisons. HEAD/base both printed the full hash above, branch printed cloud-integration, and the reverse range was empty. All 42 initially pinned host/engine/test files remained byte-identical at the final comparison. The implementation's 18 individual file hashes and aggregate match exactly.

# Pinned scope

Production delta is +175/-198 lines across ten files, including two new internal modules. Tests/fixtures are +1,123/-0 across eight files. No existing tests were deleted or moved in this lane. The duplicated effect partitions, duplicated result mapping, admission transition loop and fake durable executor were removed. The added public method is Store.getNodeRun; no shared schema migration or package export change belongs to this lane.

Aggregate SHA-256 over sorted relative-path, NUL, file-digest, newline manifest rows is `98409beae9cade286d5a1cb3d2a0eb7b303d259d97ade07130cb548b377f6d11`. This matches the implementation receipt and includes the following exact source/test bytes. This report and review probes are excluded from that aggregate.

| File | SHA-256 |
| --- | --- |
| `packages/loopy/_tests_/host-admission-race.test.ts` | `e62d37f13178f3f71acc62c1dc13aff23226df2371a9721cf78b4e91952a0da0` |
| `packages/loopy/_tests_/host-denial-fence.test.ts` | `ff43e4c62a674d92a3c1cfb696886c9fe502403397c4bcf367fee7217ac09240` |
| `packages/loopy/_tests_/host-policy-fixture.ts` | `b544b289439ec1723f3f8452476ff7c716cf5c37901b4e82dde6e31876f2be61` |
| `packages/loopy/_tests_/host-policy-model.test.ts` | `3c1f4482bef770261908139a2c87be5ed7c48f1d38deed5f38f39c1867ddc9ec` |
| `packages/loopy/_tests_/host-policy-model.ts` | `039bcee19ba2bf759dd12a5ec2803c2d9479b751cd4654d3322c3be10c010f17` |
| `packages/loopy/_tests_/host-policy-replay.ts` | `431ce71227044e5db7e87e3041ba7757e49f279fdd67e5d5cfeef1010b1eb41e` |
| `packages/loopy/_tests_/host-slot-retention.test.ts` | `87eeb8db99c3b29aea7d906b3ca225c6b2a2450338c9a9444c0f2380ef356aa3` |
| `packages/loopy/_tests_/host-targeted-polls.test.ts` | `1fc4d1444e51719ec9fd23186c146b2a81c1fad3837e356a4f734c8bda185117` |
| `packages/loopy/src/core/store.ts` | `03e0a6c0cfb5e7723251976eb13851fee4d1181fb0ac4219c234be3e63ca0b50` |
| `packages/loopy/src/host/activate.ts` | `71944a1fbee7f527ac641ff41dca935a9fd290d0dc252ce7236b2356cdd88de0` |
| `packages/loopy/src/host/activation-plan.ts` | `a4addedb82e85bc6f22c317e34ee524eda9ac0304da24ed101bef5b07f8f99aa` |
| `packages/loopy/src/host/activation-work.ts` | `933e388aa1cbcdf6f6f96ecd4a3618a78f3cef1407756993b6df8cd31a247b65` |
| `packages/loopy/src/host/completion-event.ts` | `9a17b7e338ce0e345d70d092aa40df299d37fa5a76111fd150bedd62da0173f0` |
| `packages/loopy/src/host/durable-work.ts` | `b69a0b2bad5d04a2e44dea957941d9c2b0a45aeedda843238248b18ac14fd78a` |
| `packages/loopy/src/host/durable.ts` | `2abe93ce559fc24e920a1f01160bcabe1657882ff3d4f96d51670ea99ecfeae1` |
| `packages/loopy/src/host/rate-limit.ts` | `7ed185dbd214a075b74dcd232e6034719863714bfc3d752d75ffc6fbbf3c83e1` |
| `packages/loopy/src/store/memory-nodes.ts` | `5463625c0ee801ab52bffa207c52b32f3d0a48f9c0608caa3a02bc6a5d35de2d` |
| `packages/loopy/src/store/sqlite/nodes.ts` | `94352f8bed15222f529dd018aa2e1349dee9f095979f04bf4ec88974ace8385a` |

# Remaining integration gates

No blocker requires a source correction in this lane. The model limitations and the serialized receipt-started write are explicit constraints on this approval. The parent's full check, repeated workload, real workerd/provider exercises and final integrated-tree review remain separate evidence. This review neither runs nor waives them. Unrelated lanes may continue; a change to these pinned bytes needs review of the changed scope before carrying this verdict forward.
