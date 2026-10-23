# Persistence and execution authority quality review

Reviewer: Opus, independent pass. I read no other reviewer reports or acceptance verdicts. I read no design notes before forming these conclusions.

## Pins

- Branch `cloud-integration`, HEAD `9d30ca923d168e299099758e0d95f3db3ba81cf0`. `main` also points at this commit, so the range has already landed.
- Primary range `6ffecdfd60e16aaa335467684d918b3cd8b44813...9d30ca923d168e299099758e0d95f3db3ba81cf0`. Commits in order: `69de89c` (inject execution authorities), `7f6976a` (evidence), `9d30ca9` (evidence).
- Context baseline: `dee31da...6ffecdf`. I used it only to tell older debt from new regressions. Before files came from `git show 6ffecdf:<path>`.

## Inspected paths

Source:

- `apps/sandbox/src/`: `attempts.ts`, `attempt-admissions.ts`, `attempt-monitor.ts`, `attempt-exports.ts`, `attempt-reconciliation.ts`, `attempt-dependencies.ts`, `filesystem.ts`, `filesystem-authority.ts`, `filesystem-journal.ts`, `journal-files.ts`, `immutable-results.ts`, `http-authority.ts`, `receipts.ts`, `admission.ts`, `result.ts`, `server.ts`, `index.ts`, `config.ts` (diff only), `artifacts.ts` (diff and callers), `docker.ts` (interface only).
- `apps/cloud/src/`: `receipts.ts`, `receipts-authority.ts`, `receipts-sql.ts`, `receipts-identity.ts`, `receipts-results.ts`, `receipts-route.ts`, plus the `worker.ts` and `environment.ts` diffs.
- `packages/loopy/src/contract/`: `sandbox-journal.ts`, `sandbox-journal-rpc.ts`, the `index.ts` diff.
- `packages/loopy/src/executor/`: the `receipts.ts`, `local.ts`, `execution.ts`, `worker.ts` and `index.ts` diffs. Also `local/daemon.ts`, the one production composer.
- Helpers I checked for duplicates: `core/canonical-json.ts`, `core/revision.ts`, `contract/compiled-validation.ts`, `core` `errnoCode`.

Composition traces: `apps/sandbox/src/index.ts`, `scripts/playground/provider.ts`, `scripts/playground/verify-receipts.ts`, `scripts/playground/receipt-evidence.ts`, `scripts/cloud/filesystem-receipt.ts`.

Tests, by name and selected bodies: `sandbox-authority-{contract,model,lifecycle,delayed,shutdown,publication,helper}.test.ts`, `cloud-receipt-{authority,export,http,recovery,results}.test.ts`, `local-receipts{,-recovery}.test.ts`, `executor.test.ts:170-200`, `cloud-sandbox.test.ts:660-700`, `fixtures/local-receipts.ts`, `fixtures/sandbox-authority-model.ts` (head), `fixtures/architecture-docker-resources.ts:195-235`.

Docs: `apps/sandbox/README.md`. AGENTS.md was read for the rules.

I ran static commands only (`git show`, `git diff`, `git grep`, `sed`). I ran no tests, typecheck or services.

## Overall verdict

The refactor did not make this area a mess, but it is harder to maintain than it needs to be. The structure got better. One 270-line `Attempts` class became admission, monitoring, export and reconciliation units. A closed operation table types the wire. Failures are a closed enum. Local receipts are one class with explicit `claim` and `finish`. The SQL authority fences every write with a session inside one transaction.

The cost is duplication. One authority state machine (admit, complete, beginExport, endExport, recoverable) is now written by hand twice, once in `FilesystemAuthority` and once in `ReceiptAuthority`/`SandboxReceipts`. Plan identity rules are written three times. The two copies have already drifted on edge cases, and only the filesystem copy is model-checked. Two more things add reading cost. The old flat receipt shape lives on as the Docker backend and reader parameter type, so four sites rebuild it from the new plan. The local executor gained a descriptor and an optional injection seam that repeat `home`.

I found no correctness blocker. Every divergence below is latent, meaning no current caller reaches it. Fixes 1 to 4 are worth doing before more authority work lands on top of this code.

## Findings, prioritized

### 1. Authority policy is duplicated across two adapters and has drifted (valuable cleanup, latent correctness)

Where:
- Filesystem: `apps/sandbox/src/filesystem-authority.ts:68-215`.
- Cloud: `apps/cloud/src/receipts-authority.ts:25-167` plus the precheck at `apps/cloud/src/receipts.ts:66-100` and the plan check at `apps/cloud/src/receipts.ts:114-119`.

Before: `6ffecdf` had one `ReceiptStore` (`apps/sandbox/src/receipts.ts` at 6ffecdf, 40-121) and no remote authority, so the policy had one owner.

After: each adapter writes its own decision order and rejection codes. I compared them line by line and found these drifts:

- endExport with an unknown token. Filesystem treats it as a no-op (`filesystem-authority.ts:201-213`). Cloud throws `missing`, which becomes a 409 and then an `AuthorityError` thrown by the client (`receipts-authority.ts:159-161`, `receipts.ts:54-55`, `http-authority.ts:51-57`).
- complete on an already finished inline record. Filesystem hashes the inline value and accepts a matching ref (`filesystem-authority.ts:113-121`). Cloud rejects any non-blob record (`receipts-authority.ts:66-72`, `receipts-sql.ts:112`).
- Rejection order on admit. Filesystem checks the session before plan validity (`filesystem-authority.ts:70-76`). Cloud checks plan validity first, outside the transaction (`receipts.ts:115-117`). A stale caller with a bad plan gets `stale_session` from one adapter and `invalid_state` from the other.
- Cloud complete runs the same five checks twice in one app: `receipts.ts:67-94`, then `receipts-authority.ts:54-75` inside the transaction. The comment at `receipts.ts:96` says why the R2 read happens outside the transaction. It does not say why every rejection check is repeated.

Consequence: every new authority rule or code must be written twice and kept equal by eye. `sandbox-authority-model.test.ts:142-155` replays model traces against `FilesystemAuthority` only, so no test catches drift in the DO adapter.

Smallest safe correction:
1. Delete the complete precheck in `receipts.ts:67-94`. Read the record only to learn its workspace, verify the bytes, then call `authority.complete`, which already rechecks everything in its transaction. If an R2 verify failure on a rejected request must still return the rejection code rather than a 500, return `authority.complete`'s rejection when the record is missing or its hash conflicts. One read plus one branch covers that.
2. Run the existing model replay (`fixtures/sandbox-authority-model.ts`) against the workerd authority through `fixtures/receipt-harness.ts`. That turns the drift into a failing test.
3. Optional, larger: extract pure decision functions such as `decideAdmit({ current, existing, busy, validPlan, input })` into a module both adapters import. Each adapter keeps only its I/O and persistence.

Validation: the replay from step 2 must pass against both adapters, or fail on exactly the drifts above until one side is aligned. Then run the `cloud-receipt-*`, `sandbox-authority-*` and `cloud-sandbox` tests and `bun run check`.

### 2. Plan identity derivation exists three times (valuable cleanup)

Where:
- Construction: `apps/sandbox/src/attempt-admissions.ts:101-111`.
- Filesystem validation: `apps/sandbox/src/filesystem-journal.ts:18-32`.
- Cloud validation, using WebCrypto: `apps/cloud/src/receipts-identity.ts:10-38`.
- Helper name `loopy-artifact-${id}`: built or checked at `filesystem-authority.ts:186`, `filesystem-journal.ts:133`, `attempt-exports.ts:45`, `artifacts.ts:87`, `artifacts.ts:149` and `receipts-authority.ts:137`.

Before: names were built once in `Attempts.admit` (`attempts.ts` at 6ffecdf, 150-152), and nothing re-validated them.

Consequence: these strings name Docker resources, and fencing depends on them. AGENTS.md and the craft rules both say protocol derivations get one owner. A change to the volume scheme in `plan()` silently fails `validPlan` and `validReceiptPlan` with `invalid_state`. A change in one validator and not the other makes the filesystem and DO adapters disagree.

Smallest safe correction: add one pure, browser-safe function to the contract, for example `attemptResourceNames(id, volumeHash)` returning `{ container, inputVolume, volume, helper }`, and call it from all three sites and the helper sites. Each runtime keeps its own hash call (Node `createHash`, WebCrypto), but the hash input shape should come from one function too, such as `attemptIdInput(root, identity)` and `volumeInput(root, workspace, runId)`. Point `receiptHash` at the existing hex digest in `core/revision.ts:16-21` and `contract/compiled-validation.ts:41-44`, so a fourth SHA-256-hex copy does not appear.

Validation: `cloud-receipt-http.test.ts:90` ("root-derived identities include ordered scope...") and `sandbox-authority-contract.test.ts:23` already cover the rejections. Typecheck.

### 3. The legacy flat receipt survives as the backend and reader type (valuable cleanup)

Where:
- `apps/sandbox/src/receipts.ts:11-27`: `common` repeats `dockerAttemptPlanSchema` from `contract/sandbox-journal.ts:15-22` field for field.
- `docker.ts:30-37` and `artifacts.ts:15-20` still take `StartedReceipt` and `Extract<StoredReceipt, { kind: "finished" }>`.
- Four sites rebuild that shape from a plan: `attempt-admissions.ts:138`, `attempt-monitor.ts:65`, `attempt-exports.ts:116` and `scripts/cloud/filesystem-receipt.ts:13-22`.

Evidence: `DockerArtifacts.read` uses only `receipt.volume`, `receipt.id` and `receipt.requestHash` (`artifacts.ts:96-160`). It never reads `result` or `kind`. `cleanup` added in this range already takes `DockerAttemptPlan` (`artifacts.ts:86`), so one interface now accepts both shapes.

Consequence: two names for one record. Readers have to work out that `{ ...record.plan, kind: "started" }` is a type adapter and not a state change. `receipts.ts` no longer owns receipts. It holds a legacy schema and `lockStateRoot`.

Smallest safe correction: change `AttemptBackend.start/recover` and `ArtifactReader.read` to take `DockerAttemptPlan`, and delete the four rebuilds. If the legacy disk decoder stays (see finding 7), write it as `dockerAttemptPlanSchema.extend({ kind })` and remove `common`. Rename `receipts.ts` to `state-lock.ts`, or move `lockStateRoot` next to `config.ts`'s `validateStateRoot`.

Validation: typecheck catches every fake backend in tests (`cloud-sandbox.test.ts`, `sandbox-authority-*`, `architecture-docker-*` fixtures). Then run the `cloud-sandbox` and `sandbox-authority-*` tests.

### 4. Admission control flow: `recover()` may start work, and the success tail is written three times (readability)

Where: `apps/sandbox/src/attempt-admissions.ts:127-152` and `154-225`.

`recover(record, request?)` starts the backend when a request is present, the session matches and the id has not been issued. Otherwise it reconciles. A method named "recover" that can perform the first start is the most surprising line in the sandbox. The optional parameter is a mode flag. `admit` repeats `if (record.kind === "started") this.recover(record, request); return this.publicReceipt(record);` at lines 169-173, 194-199 and 220-224. It throws `AttemptConflict` inside a `try` at line 189 only to catch and rethrow it at 202-204.

Before: `attempts.ts` at 6ffecdf, 118-166, was one linear method with no exception round trip.

Consequence: the lost-ack path is the hardest invariant here (start at most once per session, `issued` at line 145). The current shape hides it behind a misleading name and three copies of the tail.

Smallest safe correction: rename to `monitor(record, request?)` or split it into `resume(record, request)` and `recover(record)`. Narrow the `try` to the `authority.admit` call alone, compute `record` once, and keep one tail. Add a one-line comment on `issued` saying it is never cleared because a stale started read can arrive after completion. That is the correct reason, and a later reader will otherwise try to "fix" the unbounded set.

Validation: `sandbox-authority-lifecycle.test.ts` and `sandbox-authority-delayed.test.ts` cover the lost-ack and same-session start gate. They must pass unchanged.

### 5. The executor descriptor and optional receipts injection repeat `home` (valuable cleanup)

Where:
- `packages/loopy/src/executor/receipts.ts:7-12` and `71-73`: the descriptor `{ kind: "filesystem", home }`.
- `executor/local.ts:20-31`: optional `receipts?`, a default, and a runtime equality check.
- `executor/local.ts:105-113`: the descriptor sent to the child.
- `executor/worker.ts:12` and `48-55`: the schema plus the same equality check again.

Callers: the only production composer, `local/daemon.ts:24` and `39`, passes `new FilesystemReceipts(home)`, the same value the default would build. The only other injectors are tests: `local-receipts-recovery.test.ts:29-67` subclasses it to interpose a race, and `fixtures/local-receipts.ts:32`.

Consequence: the child receives `home` twice and must check that the two copies agree. `kind: "filesystem"` is a one-member union with nothing else to produce. `local-receipts.test.ts:150-168` exists only to test this descriptor. The craft rules name an optional constructor parameter with a silent default, added so a test can reach in, as a seam to avoid.

Smallest safe correction: delete the descriptor schema, the getter, the stdin field and the worker check. The worker builds `new FilesystemReceipts(request.options.home)`. Make `receipts` required on `LocalExecutor`, since daemon and tests already pass it, and keep the single equality check in the constructor. Delete or fold the descriptor test.

Validation: the `executor`, `local-receipts`, `local-receipts-recovery` and `local-daemon` tests, then typecheck.

### 6. Local liveness reconciliation runs twice per lookup (minor duplication)

Where: `executor/local.ts:45-71` and `executor/receipts.ts:131-158`.

`LocalExecutor.lookup` probes `kill(pid, 0)`, catches ESRCH with a hand-written errno check (`local.ts:50`) instead of `errnoCode`, rereads, then calls `receipts.finish`. `finish` reads again, probes again, rereads again and publishes. One lookup of a dead child does three reads and two probes.

Consequence: the "reread after confirmed death" rule from the `FilesystemReceipts` doc comment is written in two places. They will drift.

Smallest safe correction: in `lookup`, return `{ kind: "started" }` if the child is alive. Otherwise call `this.receipts.finish(uncertain)` directly, since `finish` already does the reread-after-death. Use `errnoCode`.

Validation: `local-receipts-recovery.test.ts:11` targets exactly this race and must still show `finishes === 0` (`local-receipts-recovery.test.ts:74`). Change the subclass to count publishes rather than `finish` calls if the call path changes.

### 7. The legacy filesystem receipt decoder puts an `inline` member into the shared wire contract (owner decision)

Where: the decoder is `apps/sandbox/src/filesystem-journal.ts:45-72`, with a fake session `legacy-filesystem-recovery` at line 67. The union member is `contract/sandbox-journal.ts:29-32`. Branches on `inline`/`blob` appear at `attempts.ts:107-110`, `filesystem-authority.ts:114-117`, `receipts-authority.ts:67`, `receipts-sql.ts:112`, `receipts.ts:89` and `scripts/cloud/filesystem-receipt.ts:17-20`.

The compatibility is deliberate and tested (`sandbox-authority-contract.test.ts:112`). But only the legacy decoder produces `inline`, and cloud rejects it on every path. AGENTS.md says not to add compatibility paths for discarded databases, and the craft rules require a written exit condition for any kept compatibility path. I found none in code. The state root is a local-stage worktree directory (`apps/sandbox/README.md:25`).

Smallest safe correction: either delete the legacy branch, the `inline` member and the six branches, or keep `inline` in a filesystem-only record type that is mapped to the wire type at the edge, with a dated exit-condition comment on the decoder. The root coordinator should decide whether any retained sandbox state roots matter.

Validation: if deleted, drop the legacy half of `sandbox-authority-contract.test.ts:112` and the `decodeDiskReceipt` fallback at `cloud-sandbox.test.ts:675-683`, then typecheck.

### 8. Monitors swallow every failure, including closed rejections (older pattern, extended)

Where: `apps/sandbox/src/attempt-monitor.ts:84-105`.

A `{ kind: "rejected", code }` from `complete` is turned into `throw new AuthorityError(...)` at lines 91-93. The bare `catch {}` at line 96 then retries it every 5 s until shutdown, with no log. `stale_session`, `request_conflict` and `missing` cannot succeed on retry.

Before: `attempts.ts` at 6ffecdf, 233-245, had the same catch-all around `store.finished`, which had no closed rejections. So this is older debt, and the new closed vocabulary was ignored instead of used.

Consequence: a permanently rejected attempt stays `started` while the process lives, with nothing in stderr. That includes a schema or programming error in `put`.

Smallest safe correction: branch on `completed.kind === "rejected"` before any retry. Treat permanent codes as terminal for this process: stop, write to stderr with the code and id, and leave the record for the successor. Retry only thrown transport and storage errors.

Validation: `sandbox-authority-publication.test.ts:11` (publication failures survive) must still pass. A new test that injects `stale_session` from `complete` should check that the monitor stops and `drain()` resolves.

### 9. Smaller issues (low value, cheap)

- Size policy lives in three places with three behaviors. `result.ts:18-28` (`boundedResult`) substitutes an `output_limit` failure. `immutable-results.ts:16-24` throws. `receipts-results.ts:23-35` substitutes with a different message. `canonicalJson` and `JSON.stringify` give the same length here (`core/canonical-json.ts:4-24`), so the monitor never hits the throw. Still, one port has two contracts. Let `boundedResult` own substitution and make both stores throw. Then update `cloud-receipt-results.test.ts:169`.
- `Attempts.artifact` contains a branch that cannot run, at `apps/sandbox/src/attempts.ts:154-158`. `publicReceipt` on a finished record always returns `finished`, and the union return type forces the check. Split out `resolveResult(record: Finished, resultsFor)` and use it at both sites. Move `publicReceipt` out of `Attempts` so `AttemptAdmissions` stops receiving a callback into its parent (`attempts.ts:60`, `attempt-admissions.ts:32`).
- `id()` is duplicated verbatim at `attempts.ts:89-96` and `attempt-admissions.ts:57-64`.
- `journal-files.ts:20-22` (`missing`) and `immutable-results.ts:77` hand-write errno checks. `core` `errnoCode`, already used at `apps/sandbox/src/artifact-worker.ts:115`, covers both. `receipts.ts:29-37` keeps its own `syncDirectory` beside the exported one in `journal-files.ts:10-18`.
- `ReceiptAuthority` issues raw SQL (`receipts-authority.ts:120-126`, `140-147`, `163-165`) even though `ReceiptSql` claims to own SQL. Move those three statements into `ReceiptSql` as `startedOn(volume)`, `insertExport(record)` and `deactivateExport(token)`.
- Operations are listed by hand in four places: `authorityCommandSchema` (`sandbox-journal-rpc.ts:116-136`), the `SandboxAttemptAuthority` interface (88-97), the client methods (`http-authority.ts:105-159`) and the DO switch (`apps/cloud/src/receipts.ts:102-135`). The DO's return type is a loose union, so a wrong output for an operation compiles. A handler map typed as `{ [K in keyof typeof authorityOperations]: (input: AuthorityInput<K>) => Promise<AuthorityOutput<K>> }` would let TypeScript enforce outputs. The command union could then be derived from the table.
- Every admission scans all recoverable records. `AttemptExports.reconcile(volume)` (`attempt-exports.ts:57-58`) pages every started attempt and guard just to find guards on one volume, and in DO mode each page is an HTTP round trip. Fine at today's concurrency. A `guards(volume)` operation, or a `kind` filter on `recoverable`, would make it O(guards).
- Authority and results are injected separately but must share storage. `AttemptDependencies` (`attempt-dependencies.ts:6-12`) takes `authority` and `resultsFor` as independent fields. `FilesystemAuthority.complete` verifies blobs through its own `FilesystemResults` (`filesystem-authority.ts:124`), so a `resultsFor` pointing elsewhere fails every completion. `HttpSandboxAuthority` already has `resultsFor`. Give `FilesystemAuthority` one too and inject a single object.
- One concept goes by four names: journal, authority, receipts, records. Examples are `contract/sandbox-journal*.ts`, `FilesystemJournal`, `FilesystemAuthority`, `SandboxReceipts`, `ReceiptAuthority`, `/internal/sandbox-receipts` and `X-Loopy-Receipts-Namespace`. Renaming the two contract files to `sandbox-authority.ts` and `sandbox-authority-rpc.ts` alone would help.
- `receiptAccess` and `receiptsConfiguration` run twice per request, once in the Worker (`receipts-route.ts:75`) and once in the DO (`receipts.ts:37`), and the body is bounded twice. That is acceptable defense in depth. A bounded-read failure inside the DO falls through to `storage_unavailable` 500 (`receipts.ts:43`, `57-58`) instead of 400.
- `pause` is exported from `attempt-monitor.ts:13` and imported by `attempt-reconciliation.ts:4`. It belongs in a shared helper, or in the reconciliation file next to its second caller.
- The state classes each copy every options field into a matching `private readonly` field (`attempts.ts:32-44`, `attempt-admissions.ts:26-48`, `attempt-monitor.ts:25-42`), while `AttemptExports` uses parameter properties. This is a style preference and should not be prioritized.

### 10. Stale docs (valuable, cheap)

`apps/sandbox/README.md:77` and `87` still describe a finished receipt that replaces the started file with the result inline, and say that "removing receipts permits re-execution". After this range, results live in `results/` as content-addressed blobs. Exports leave guard and released files in `exports/`. Sessions fence writers. A durable-object authority can replace the filesystem one. `startSandbox` now takes a dependency factory (`server.ts:168-177`). None of this is in the README. The pr-review rules want refactors to document the new architecture and flows. Design notes exist under `.notes/cloud/architecture/`, but the checked-in README that operators read is out of date. Update the durability and cleanup paragraphs, and add a short paragraph on authority modes.

## What improved

- `executor/receipts.ts` now holds one class with `read`, `claim`, `finish` and `publish`. It reuses `sandboxExecutionResultSchema` instead of a private copy, uses `errnoCode`, refuses to overwrite a live child (`receipts.ts:146-153`), and `execute` returns an existing finished result instead of crashing on EEXIST (`execution.ts:55-63`).
- The wire contract is a single operation table. Inputs and outputs are `strictObject`, failures are a closed `authorityFailureSchema`, and admit, complete and beginExport return rejections as values. The HTTP client parses every response through the operation's schema with no casts, and its body reader is bounded.
- The SQL authority fences every mutation by session inside `transactionSync`. A partial unique index enforces one active export per volume (`receipts-sql.ts:29`). Recovery pages by index rather than full scans. R2 publication is a conditional create plus verified read.
- The `Attempts` split gives monitoring, exports and admission separate homes, and shutdown is now idempotent (`attempts.ts:176-193`). `server.ts:190-193` fixes the stop ordering so the lock outlives in-flight work.
- Tests: the finite model test (`sandbox-authority-model.test.ts`) is the right kind of test for this code. The workerd tests use the real runtime instead of mocks. All new tests live under `_tests_`.

## Scope gaps

- I did not run anything, so every finding comes from reading the code. Findings 1 (drift), 8 and the size-policy item are worth a targeted reproduction by root.
- I read `docker.ts`, `artifacts.ts` and `artifact-worker.ts` only at the interfaces and callers this range touched.
- I read none of the host, store, service, read-model or dashboard changes in the range. They belong to the paired scope.
- I read `scripts/playground/*` only for composition (`provider.ts`, `verify-receipts.ts`, `receipt-evidence.ts`). I did not review the baseline, stack or supervisor tooling.
- I read the large test fixtures (`architecture-docker-*`, `receipt-harness`, `readmodel-*`) only around composition points and did not judge their size or upkeep in detail.
- The DO authority is composed only by `scripts/playground/provider.ts:27-45` and test fixtures. The production sandbox entry (`apps/sandbox/src/index.ts:35`) always uses the filesystem authority. I treated that as intended for the local stage. If DO mode is meant to ship, it needs a real composer, an `httpDependencies` beside `filesystemDependencies`, so scripts and fixtures stop building it by hand.
