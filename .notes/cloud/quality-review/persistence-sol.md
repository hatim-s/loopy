# Persistence and execution authority quality review

## Verdict

The persistence design is better, but following a sandbox request now takes more effort. The local executor refactor is a clear improvement. The sandbox refactor introduces useful ownership boundaries and necessary durable authority, while also carrying some old receipt-shaped coupling into the new design.

I found no correctness blocker. I found one P2 artifact availability regression, one P2 cleanup with a concrete admission-cost consequence, and one smaller P3 duplication cleanup. These warrant targeted changes, not another architecture rewrite. The added recovery machinery and boundary tests have a purpose and should stay.

This is a static review. The failure paths below follow from actual callers, but I did not execute reproductions or tests. No claim here adopts another reviewer's acceptance verdict.

## Source pins and scope

- Checkout: `/Users/hatim.shakir/projects/loopy/cloud-integration`.
- Observed branch: `cloud-integration`.
- Observed HEAD: `9d30ca923d168e299099758e0d95f3db3ba81cf0`.
- Reviewed three-dot range: `6ffecdfd60e16aaa335467684d918b3cd8b44813...9d30ca923d168e299099758e0d95f3db3ba81cf0`.
- Observed merge base: `6ffecdfd60e16aaa335467684d918b3cd8b44813`.
- Scoped source delta: 31 changed files, 2,599 lines added and 363 deleted. This includes new durability behavior, so it is not a like-for-like extraction count.
- Initial status showed an untracked `.notes/cloud/quality-review/` directory. I did not inspect other reports in it.

The reverse log contains:

1. `69de89c` Inject execution authorities and simplify host and read-model policy.
2. `7f6976a` Record architecture workload, recovery and scaling evidence.
3. `9d30ca9` Record main integration and watcher recovery verification.

Classification: major architecture refactor with explicitly bundled related fixes. The bundle is authorized and is not a scope finding.

## Prioritized findings

### 1. P2, availability regression: artifact export unnecessarily depends on terminal-result storage

Primary location: `apps/sandbox/src/attempts.ts:154-160`.

Related locations: `apps/sandbox/src/attempts.ts:107-110`, `apps/sandbox/src/attempt-exports.ts:95-116`, `apps/sandbox/src/artifacts.ts:14-19,94-223`.

The artifact path has already checked that the authority record is finished. It then calls `publicReceipt`, which fetches the immutable result blob, checks the returned union a second time, and passes the result through `AttemptExports.read` merely to reconstruct the old `StoredReceipt` shape. `DockerArtifacts.read` never reads `receipt.result`. It needs the attempt's Docker plan, ownership hash and workspace volume.

The actual request chain is `artifactResponse` in `apps/cloud/src/artifact-route.ts` to `SandboxProvider.artifact` to `attemptHandler` to `Attempts.artifact`. If an already-terminal run's result blob is unavailable or corrupt while its workspace volume remains readable, this extra GET throws before `beginExport` or the artifact reader runs. Existing files become unavailable for a reason unrelated to export authority. Even healthy requests incur an unnecessary result read and transfer of up to the result byte cap. The cloud receipt tests explicitly establish that a terminal authority record remains terminal when its blob is missing, so this is a state the new design otherwise distinguishes correctly.

Before: `6ffecdf:apps/sandbox/src/attempts.ts:190-216` passed the already-read inline receipt to the reader. There was no independent result-storage dependency to fail. The reader's broad receipt parameter was preexisting; the new blob indirection makes that coupling consequential.

Smallest safe correction: make the reader accept the Docker plan it actually uses. Remove the result parameter from `AttemptExports.read` and bypass `publicReceipt` in the artifact path. Preserve the finished-record check, atomic `beginExport`, helper identity checks, cleanup confirmation and `endExport`. Result lookup should continue verifying result bytes when the caller actually requests an execution result.

Validation obligation for root: use an isolated injected result store whose `get` rejects after a terminal record exists, then request an artifact through `Attempts.artifact` or the HTTP handler. Export should still acquire and release its guard and return the file. Keep the existing busy-volume, failed-cleanup and shutdown cases passing, and verify ordinary receipt lookup still fails closed for missing result bytes. No Docker or real state is needed for the narrow reproduction.

### 2. P2, valuable cleanup: an export-cleanup helper hides a full attempt-recovery scan on every new admission

Primary location: `apps/sandbox/src/attempt-exports.ts:57-58`.

Related locations: `apps/sandbox/src/attempt-admissions.ts:176-177`, `apps/sandbox/src/attempt-exports.ts:15-27`, `apps/sandbox/src/filesystem-authority.ts:217-232`, `apps/sandbox/src/filesystem-journal.ts:81-94`, `apps/cloud/src/receipts-sql.ts:165-229`.

`AttemptAdmissions.admit` calls `exports.reconcile(plan.volume)` for every previously unseen attempt. That method uses `recoveryRecords`, which retrieves every page of both started attempts and export guards, collects both arrays, then discards the attempts and filters guards by volume only after retrieval.

On the filesystem adapter, every recovery page calls `journal.records`, which reads and parses every receipt, including finished history. Thus even an admission with no export guards now reads the whole receipt history. With multiple recovery pages it rereads that history for each page. Across a growing sequence of completed attempts, the receipt-read work on this admission path grows quadratically with history size. This is a source-derived cost, not a measured latency claim.

The cloud adapter avoids terminal-history scans with indexes, which is good. It still transfers all live attempt records and unrelated guards across HTTP before the caller discards them. The method name `exports.reconcile(volume)` conceals that unrelated work, making future admission-cost reasoning harder.

Before: `6ffecdf:apps/sandbox/src/attempts.ts:124-163` read the target receipt, checked an in-memory export-volume set, and wrote the new receipt. The old filesystem `pending()` scan existed at startup and during artifact export, not on every new admission. Moving a whole-history scan onto ordinary admission is new.

Smallest safe correction: give export reconciliation an authority query for export guards, with an optional volume filter, instead of using the combined attempt/export recovery enumerator. The filesystem implementation can enumerate guards without calling `records`; the cloud implementation can query active guards by volume. Keep combined recovery for startup. Preserve authoritative admission/export exclusion and delayed export-acknowledgement recovery. A local cache alone is insufficient to settle an ambiguous remote guard creation.

Validation obligation for root: count calls or receipt reads with unrelated terminal history and more than one page of started attempts. A new admission should query relevant export guards without enumerating attempt history. Retain tests proving an unresolved same-volume guard blocks admission and an unrelated volume progresses. Use temporary fixture state and injected adapters; no workload benchmark is required to establish the unnecessary calls.

### 3. P3, valuable cleanup: extraction duplicated the attempt identity calculation between admission and lookup

Primary location: `apps/sandbox/src/attempt-admissions.ts:57-64`.

Related locations: `apps/sandbox/src/attempts.ts:89-96`, `apps/sandbox/src/filesystem-journal.ts:18-30`, `apps/cloud/src/receipts-identity.ts:10-38`.

The new `AttemptAdmissions.id` is an exact copy of `Attempts.id`. Admission uses one copy; lookup, artifact retrieval and admission waiting use the other. At baseline, all those operations used the single `Attempts.id` method. A future change to identity inputs now has to update both private methods or the caller will wait on or look up a different key from the one it admitted.

There is no current identity mismatch. This is an introduced maintenance hazard in a durable identity rule, not a reported execution failure. Root/plan validation in the filesystem and cloud adapters is necessary and should remain.

Smallest safe correction: move the sandbox's root-plus-attempt identity calculation into one named helper next to `attemptHash` and use it in both classes. The filesystem plan validator can reuse it too. Preserve the existing canonical payload and resulting hashes. This does not require a generic hashing strategy, a new package, or removal of independent authority validation.

Validation obligation for root: keep existing identity, duplicate-admission, lookup and artifact tests passing with unchanged hashes. Include an ordered scoped execution key when checking equality. No new standalone test that merely restates the helper is needed.

## What improved

- `Attempts.open` now builds dependencies under the process lock. `filesystem.ts` and the durable branch in `scripts/playground/provider.ts` make storage selection visible at composition rather than silently constructing a private store inside `Attempts`.
- `FilesystemReceipts` owns identity checking, exclusive claims and terminal publication. `ExecutionWorker.execute` now handles an existing claim explicitly. `LocalExecutor` sends a parsed descriptor across the child boundary rather than attempting to serialize its injected object.
- The local terminal writer preserves finished receipts, rejects unclaimed publication and checks child liveness before a parent writes uncertainty. The second read after confirmed death matters. It should not be removed as redundant validation.
- Authority RPC schemas own their wire types. The code uses discriminated unions for admission, completion, export and result locations, with a closed list of authority rejection codes. I did not find cast-heavy transport shortcuts in this scope.
- `AttemptMonitors` retains an observed terminal result across byte and pointer publication failures. The baseline recovered from Docker again after any publication failure. Keeping the observation avoids changing a known result merely because storage failed.
- Export guards now persist across service restart. Helper cleanup checks ownership and confirms removal before authority is released. These are substantive guarantees, not excess abstraction.
- `ReceiptSql` keeps live recovery and busy-volume lookups indexed. The completion path verifies durable bytes before publishing their pointer and rechecks session authority in the transaction. The two checks around that asynchronous boundary are justified.
- The added tests target exclusive claims, terminal preservation, lost acknowledgements, delayed commits, session fencing, export/admission races and shutdown ordering. The finite model is independent of implementation transitions and is replayed against filesystem authority. These are useful durable-boundary tests.

## Remaining design assessment

The admission, monitor and export split mostly follows responsibility. It is more work to read than the previous single `Attempts` class, but the new session, publication and durable guard behavior explains much of that increase. `attempt-reconciliation.ts` is a small helper, yet it contains a real retry boundary. Its size alone is not a reason to merge it elsewhere.

Authority policy is repeated between `FilesystemAuthority` and `ReceiptAuthority`. Session checking, request conflicts, terminal immutability and export exclusion appear in both, and the filesystem and cloud tests are maintained separately. I would not add a shared transition framework as part of these fixes. Their persistence mechanisms differ enough that such an abstraction needs more justification. The model replay currently covers filesystem authority; the separate cloud suites cover many corresponding invariants. This is useful coverage, but it is not evidence of complete adapter equivalence. For example, an unknown `endExport` token is a no-op in the filesystem adapter and a `missing` error in cloud authority. I found no current production caller that relies on that difference, so I am not promoting it into a correctness finding.

The catch-and-retry monitor style was already present at baseline. The new code still discards the specific caught error, including authority rejections, which makes diagnosis harder. I did not establish a new actual-caller correctness failure from that alone and do not count it as a new regression.

The legacy decoder has an actual persisted-data reader and associated tests. Docker execution and artifact signatures also still consume the old flat receipt shape. That is awkward ownership, particularly for finding 1, but it is not dead code. I do not recommend deleting recovery support for existing receipts merely to remove lines. A one-time format migration would be separate work with its own recovery obligations.

The file named `receipts.ts` now mostly owns process locking plus the old receipt schema. Renaming or splitting it would be a subjective navigation improvement. It is lower value than the concrete coupling and query fixes above and is not an actionable finding here.

## Inspection and validation record

Read the supplied and on-disk `AGENTS.md`, `unslop`, `pr-review`, `typescript-codebase-craft` and its TypeScript, architecture and test references. Read Planloft writing guidance when preparing this report; the user's explicit Markdown destination overrides its default storage workflow.

Inspected all changed source in the assigned scope, using the full scoped diff and complete new-file contents:

- `apps/sandbox/src/`: admission, artifacts, attempt admissions/dependencies/exports/monitor/reconciliation/coordinator, config, filesystem composition/authority/journal, HTTP authority, immutable results, journal files, receipts, result and server.
- `apps/cloud/src/receipts.ts`, `receipts-authority.ts`, `receipts-identity.ts`, `receipts-results.ts`, `receipts-route.ts`, `receipts-sql.ts`.
- `packages/loopy/src/executor/`: execution, index, local, receipts and worker changes; unchanged protocol and redaction code.
- `packages/loopy/src/contract/sandbox-journal.ts`, `sandbox-journal-rpc.ts`, plus the sandbox contract.

Traced composition and consumers through `apps/sandbox/src/index.ts`, Docker backend/client, process bridge, execution worker and artifact worker; `packages/loopy/src/local/daemon.ts`; `scripts/playground/provider.ts`; `scripts/cloud/filesystem-receipt.ts`; and cloud provider/artifact route code.

Inspected these associated tests and fixtures:

- `sandbox-authority-contract`, `sandbox-authority-delayed`, `sandbox-authority-helper`, `sandbox-authority-lifecycle`, `sandbox-authority-model`, `sandbox-authority-publication`, `sandbox-authority-shutdown` test files.
- `cloud-receipt-authority`, `cloud-receipt-export`, `cloud-receipt-http`, `cloud-receipt-recovery`, `cloud-receipt-results` test files.
- `local-receipts` and `local-receipts-recovery` test files.
- Scoped changes in `cloud-sandbox.test.ts`, `executor.test.ts` and `fixtures/executor.ts`; authority fixtures/model/lifecycle, receipt harness, local receipt fixtures/child; selected composition sections of architecture Docker runtime/proof fixtures.
- Root `package.json` and `biome.json` changes for test inclusion and evidence-file tooling treatment.

No tests were deleted or moved in the receipt/executor/sandbox test subset. Existing tests were adapted to dependency factories and the new record shape. No source, configuration or tests were changed by this review.

Commands used were static reads: `pwd`, `git branch --show-current`, `git rev-parse HEAD`, `git status --short`, `git merge-base`, `git log --reverse --format='%h %s' <base>..<head>`, `git diff` with scoped paths and stat/name/numstat modes, `git show <base>:<path>`, `rg`, `rg --files`, `cat`, `nl -ba`, `sed` and `awk`. Pin commands printed the branch, HEAD and merge base recorded above; numstat aggregation printed `31 scoped source files; 2599 added; 363 deleted`. Two exploratory reads named nonexistent paths, `apps/sandbox/src/docker-execution.ts` and `packages/loopy/src/cloud`; subsequent inventory identified the actual files and caller paths.

Scope gaps: no dynamic checks, code-importing tests, services, ports, APIs, Docker commands, database/workload reads or mutation probes ran. I did not inspect other reviewers' reports, acceptance verdicts or proposal documents. I did not need the broader `dee31da...6ffecdf` baseline. Test behavior is assessed from source, not a passing execution claim. Host scheduling, general cloud artifact registry, read models, dashboard behavior and the workload evidence are outside this assigned lane. Root owns any reproduction and eventual `bun run check` gate after authorized fixes.
