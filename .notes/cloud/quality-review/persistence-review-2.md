# Persistence review, round 2

Independent static review of the persistence correction. No source edits, tests, checks, Docker, cloud calls or service actions. Root's full check was running concurrently.

## Pins

- Branch `cloud-integration`, base HEAD `9d30ca923d168e299099758e0d95f3db3ba81cf0`, changes uncommitted.
- Source-only binary diff, handoff file order: `58b0dc108eaa5ddd7926a900d48293a5b1a77190bd05487745c36778faa31b8f`. This matches `fix-persistence.md`, so the reviewed source is the frozen handoff source.
- Test/fixture binary diff over the 8 lane test files below, in that order: `4a428d574e907344fab59c102f41e54bf2f8e5a5ff876d572515a72c418e6ca4`.

Reviewed file SHA-256 (working tree):

```text
765e9a5603fbbd6eb150e412c1528e6e82fc27ddd2c6613f998c77eda4d52060  apps/sandbox/src/admission.ts
a97012f88b590da1c573755f76247742e8dd0b0a2136a15b77b80d17dba63489  apps/sandbox/src/artifacts.ts
743f2d1d2d4b415fcd7b93715eed0099f654e8f20365ea0a0ec96c5fe6cb8a21  apps/sandbox/src/attempt-admissions.ts
2f8bf2097156a95e68b836f93a7dadcd482d9380e2256a9cd2b36089a2be8d0d  apps/sandbox/src/attempt-exports.ts
cddde56c8d66f97e93aa10a2707059ae89a41775230fa21ba2c81b33079237fd  apps/sandbox/src/attempts.ts
173186f96782d864a2642f764f011fe558390104d232c55e31b2dd2cc71099cf  apps/sandbox/src/filesystem-authority.ts
c9cfe1ee2123f6b9f584ffbff0bc2e0fd7abe1237ada5b06c2bf2f628be15e54  apps/sandbox/src/filesystem-journal.ts
f69f136ea284537652a6e2590522d89c165af20b543ba3686a57ceb0ee35b4d4  apps/sandbox/src/http-authority.ts
e1ded94765a6b463ba2e5ca929fd8af1f6d7f3b59865457d0a4b3cbfc64b8f84  apps/sandbox/src/receipts.ts
ecb034a3549567267bcec208021799a255b2b819fc1075e453aa513904b38621  apps/cloud/src/receipts.ts
675c4e735463f5004d26fd9d5a96d543deebd453b376e1f03db3c436a1c6024b  apps/cloud/src/receipts-authority.ts
1e7be270dd52c42aa98d76f432afa87446ef0e4f72c99f423fe942357dfbef4f  apps/cloud/src/receipts-identity.ts
db4225fa5640448ef67cb0cd0240bcd5fc2812deee6ca76db471b5c625c1be9e  apps/cloud/src/receipts-sql.ts
20617658c6bfbfebca2708a3ebf7f012e4f8fbc3021e46be3bf7f3abc0764cd4  packages/loopy/src/contract/sandbox-journal.ts
1f4ecd7e1b70d15d7d3df0fcd080864b9b9d05dafa20096d811aa52872744592  packages/loopy/src/contract/sandbox-journal-rpc.ts
8dea3c9a61ea9c86b24d634f27a658833c0ef50c6743cc881259764f52c5a2f0  packages/loopy/_tests_/sandbox-authority-publication.test.ts
1ae827184d17ed05516c7ffab170ffeac6187e3ec5dfa00663ffdecdd38a8dbd  packages/loopy/_tests_/sandbox-authority-contract.test.ts
f12292b96052ee32169adac3b89525ea1ae77374c2ddef9fc017a763ba3dc336  packages/loopy/_tests_/cloud-receipt-export.test.ts
13b6667f5f235101b934691f509e7574c8f5f84d539ea3fc66f8bf0010078be7  packages/loopy/_tests_/cloud-receipt-recovery.test.ts
41640503c0cc4e92ea53b7157566a72d23202c3fd0faaba61ff4ef2b4cdb1119  packages/loopy/_tests_/cloud-sandbox.test.ts
f34b8c6a5fb304e17940d53855ffde8991903f31d87f88e8d7367e2fb840ae41  packages/loopy/_tests_/fixtures/sandbox-authority.ts
948a810661d2000ff03968ead75f1f75e83a4647aa4cb8934ad133942ddfebb5  packages/loopy/_tests_/fixtures/receipt-harness.ts
85ba391f85e13a730ff38d535f696d42f4faa344525149c50d6c1d02e786c5a0  packages/loopy/_tests_/fixtures/receipt-recovery-probe.ts
```

Read for context, unchanged: `apps/sandbox/src/attempt-reconciliation.ts` (`a774feb9…bd9fa`), `packages/loopy/_tests_/fixtures/sandbox-authority-lifecycle.ts` (`ed2a114b…4cbb`), `scripts/cloud/transport-failure-resources.ts` (`6797b058…8709`).

## Verdict

Approve with limits. I found no new correctness defect. All four accepted findings are fixed, and every guard in the brief survived. Four non-blocking cleanups follow. The first is worth doing before commit because it removes a contract mode that nothing in production calls.

Classification: minor refactor plus a bounded-query performance fix. TRIAGE item 1 groups these on purpose, so I don't treat the grouping as a split blocker. The commit message should carry the admission and export flow from `fix-persistence.md` sections 1 to 5, because that is the only place the new call graph is written down.

## Invariant checks

Each check states the mechanism I traced.

- **Hashes and names unchanged.** `attemptIdInput` and `workspaceVolumeInput` (`contract/sandbox-journal.ts:97-108`) build the same key sets the old inline objects built, and `canonicalJson` makes key order irrelevant. `attemptResourceNames` and `artifactHelperName` (`:110-120`) produce the same four string shapes. `dockerAttemptPlanSchema` is byte-identical to the old `common` in `receipts.ts`, since `hashSchema` is the same 64-hex regex. The legacy disk decode path in `filesystem-journal.ts:47-70` and inline results are untouched. `cloud-sandbox.test.ts` independently recomputes ids with the old formula, using ordered and reversed scope tuples.
- **Pagination, filter and index.** DO `exportGuards` (`receipts-sql.ts:165-197`) fetches `limit+1` rows, cuts at `limit` and returns the last token as `next`. The unfiltered query uses the partial `receipt_export_recovery(token) WHERE active=1` index. The volume query uses the partial unique `receipt_export_volume`, so it returns at most one row and needs no sort. The probe's EXPLAIN output confirms both. FS (`filesystem-authority.ts:218-236`) sorts by UTF-8 bytes with `Buffer.compare`, which matches SQLite BINARY collation. `after: ""` behaves the same in both adapters.
- **FS discovery skips attempts.** `exportMetadata` (`filesystem-journal.ts:119-142`) reads only `exports/<64hex>.json`, and the regex excludes `*.released.json`. The attempt cross-check moved into `guards()` (`:144-156`), and every mutation (`admit:87`, `beginExport:145`, `endExport:202`) and `recoverable:243` still calls it. `release()` (`attempt-exports.ts:37-53`) re-reads the authoritative attempt and checks volume and helper before cleanup. A corrupt guard now blocks only its own volume during admission, not every admission. That is narrower, and startup still fails loudly through `recoverable`.
- **Startup recovery complete.** `Attempts.open` (`attempts.ts:75-80`) pages `recoverable` to exhaustion once, releases those guards, then monitors every started record. The old code enumerated twice. The result is the same because releasing guards never changes attempt rows.
- **No live helper release.** `reconcileGuards` skips tokens in `live` and marks the volume blocked. `read` reconciles the target volume before `beginExport`, and the authority still rejects a busy volume.
- **Result reads only where used.** `Attempts.artifact` requires an authoritative `finished` record, `beginExport` re-checks `finished` inside both authorities, and the reader now gets only the plan. `lookup` still verifies the result through `publicReceipt`. The completion prechecks and transactional rechecks are unchanged.
- **Same-session first start, exactly once.** `publishAdmission` (`attempt-admissions.ts:149-172`) wraps only `authority.admit`. A thrown admit retains the request, then `resolveAdmissionRead` either returns the record or rethrows on null. On null, `retained` survives, and the next `lookup` reaches `observe` and then `monitor` with the request. `issued` is set before `backend.start` (`:138-143`) and never cleared. Other-session records always take `backend.recover`. Lookup waits on the in-flight admission first.
- **One behavior tightening.** Old code skipped the request-hash check on an `existing` admit reply. New code checks it on every path (`:195`). Both adapters already reject a hash mismatch before returning `existing` (`receipts-authority.ts:33`, `filesystem-authority.ts:81-83`), so the check never fires today. The old catch also swallowed errors from `publicReceipt` and `recover` on the `existing` path and re-read. The new code lets them throw, which is more honest.

## Findings

### 1. Unfiltered `exportGuards` mode has no production caller (low, simplification)

`AttemptExports.reconcile` is called only with a volume, from `attempt-admissions.ts:186` and `attempt-exports.ts:105`. Startup uses `reconcileGuards` with the combined `recoverable` pages. The `volume === undefined` branches are dead in production:

- `receipts-sql.ts:168-176`, the whole unfiltered SQL arm.
- `filesystem-authority.ts:224`, the `input.volume === undefined ||` clause. This path also rereads the whole exports directory per page, which is quadratic in guard count.
- `sandbox-journal-rpc.ts:69-70`, which marks `volume` optional.

Only tests exercise the unfiltered mode (`sandbox-authority-publication.test.ts:211`, `sandbox-authority-contract.test.ts:228`, `cloud-receipt-export.test.ts:143`, `receipt-recovery-probe.ts:61-66,85`).

Smallest fix: make `volume` required in the schema, delete the unfiltered SQL arm and the FS clause, and change `reconcile(volume?: string)` to `reconcile(volume: string)`. Point the paging assertions at a volume, or drop them. With the unique active-volume index, a volume page holds at most one row on DO. Keeping `after`/`limit` is defensible for FS states that break the uniqueness rule, so I would keep pagination and drop only the optional volume.

### 2. `reconcileGuards(exports, volume?)` uses `volume` as a throw flag (low, readability)

`attempt-exports.ts:68-98`. Filtering moved into the authority, so the parameter now only decides whether `blocked` throws. Startup omits it to tolerate failures, and the read and admission paths pass it to fail. That is a boolean in disguise. Smallest fix: have `reconcileGuards(exports)` return `blocked`. Then `reconcile(volume)` throws when it is true, and `Attempts.open` ignores it. That also drops the `volume !== undefined` check.

### 3. Leftover repeated identity derivation (nit)

- `attempts.ts:135` and `:138` call `attemptId(this.config.stateRoot, request)` twice in a row. That is the same pattern the accepted finding targeted. Bind it once.
- `scripts/cloud/transport-failure-resources.ts:141` still hardcodes `` `loopy-artifact-${receipt.id}` ``. It could import `artifactHelperName`. This is outside the lane, so record it as follow-up.
- `attemptHash(workspaceVolumeInput(root, x))` appears at `attempt-admissions.ts:103` and `filesystem-journal.ts:22`. A `workspaceVolumeHash` beside `attemptId` in `admission.ts` would make the Node side symmetric. Optional.
- `attemptResourceNames(id, volumeHash)` takes two positional hex strings, so a swapped call typechecks. Both validators would catch it, so this is low risk. An options object would make the swap impossible.

### 4. Copied text and copied SQL (nit)

- `receipts-sql.ts:189` says "Recoverable export is missing its active guard." inside `exportGuards`. The error is unreachable inside the sync transaction, but the copy names the wrong operation.
- `receipt-recovery-probe.ts:61-75` copies the production SQL strings for EXPLAIN. If production SQL changes, the plan assertion still passes on the stale copy. The older `busy` probe follows the same pattern. Exporting the two statements as constants from `receipts-sql.ts` would close that gap. Optional.
- `artifacts.ts:182,193` still names the plan parameter `receipt`.

## Limits and residual risk

- FS `beginExport` still scans every receipt (`filesystem-authority.ts:175`, `journal.records()`) to find a started attempt on the same volume. So the FS artifact export path is still O(attempt history). This predates the change and was outside the accepted finding, which covered admission. DO uses `receipt_attempt_volume`. Follow-up if FS mode matters at scale.
- `retained` can keep one entry when an ambiguous admit resolves to a finished or hash-mismatched record. The next `observe` clears it. This predates the change and is memory only.
- `sandbox-authority-model.test.ts` does not model `exportGuards`. It is read-only, so the model's transition coverage is unaffected.
- At 22:45 IST I saw 35 `authority-*` directories under `.loopy/quality-tests`, each holding only `package.json` and `.loopy/`, while root's check was running. I could not attribute them. All `authorityFixture` callers I traced remove their roots in `afterEach` or `finally`. Root should confirm the directory is empty once the check finishes.
- Monitor permanent-rejection policy and cross-adapter consolidation remain deferred, as root decided. I found no new correctness cause in either.
- Net readability: admission reads better. One I/O try block, one hash/monitor/receipt tail, and `monitor` now names what the method does. Source net +71 comes from the new typed query and its three adapters. Finding 1 would recover part of it.
