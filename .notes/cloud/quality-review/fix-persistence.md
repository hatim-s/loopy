# Persistence correction handoff

Starting and final branch: `cloud-integration`. HEAD remains `9d30ca923d168e299099758e0d95f3db3ba81cf0`. Changes are uncommitted. Read both persistence reports, TRIAGE, repository instructions, unslop, TypeScript craft and its TypeScript/tests/architecture references. No children, commits, pushes, Docker, cloud calls, existing-service actions, personal state or historical evidence changes. Sibling edits were preserved. No cross-owner source edits were needed.

## Behavior changes

1. `ArtifactReader.read` now takes `DockerAttemptPlan`. `Attempts.artifact` still requires an authoritative finished record but does not call `publicReceipt` or fetch immutable result bytes. `AttemptExports.read` acquires the same durable export guard, reads with the plan, confirms helper cleanup and then releases authority. Ordinary result lookup continues to verify/fetch results and rejects unavailable bytes.
2. Added the typed `exportGuards({ after, limit, volume? })` operation. It returns only active export metadata, accepts an exact optional volume and limits each page to 200. FS discovery reads export files only. Its preexisting `guards()` checks still validate the corresponding admitted attempts for authority mutations and combined recovery. Cleanup independently reads the authoritative attempt and checks volume/helper identity before removing the helper and ending export authority. The DO seeks its existing active-export recovery index, or the unique active-volume index for an exact volume. No cache decides export absence or admission permission.
3. Admission and artifact reconciliation use export-only pages. Startup retains combined paginated attempt/export recovery and cleans its recovered guards before launching attempt recovery. Cleanup failure still holds the guard, blocks its volume and permits unrelated volumes.
4. Contract functions own the exact attempt-id input, run-volume hash input, Docker resource names and artifact helper name. Bridge admission/lookup and both adapters reuse them. Node crypto and WebCrypto remain separate hash implementations, and both validators still independently compare ids and resource names against the configured root. Canonical payloads and hashes are unchanged. An existing real-caller test now exercises ordered/reversed scope tuples and compares stored ids to the prior canonical SHA-256 formula.
5. Renamed `AttemptAdmissions.recover` to `monitor`, since this method can issue the first same-session start. Admission now has one hash-check/monitor/public-receipt tail. The catch covers only authority admission I/O, and request/hash retention survives ambiguous null resolution. Lookup remains first. The issued marker still precedes backend callbacks, remains set after completion, and other-session records recover without first-start work.
6. The legacy disk receipt schema extends the existing plan schema instead of repeating its fields. Persisted legacy decoding and inline results remain supported. Native receipts, completion prechecks, immutable result verification and monitor permanent-error behavior were not changed. Backend parameters remain `StartedReceipt`; widening that refactor was unnecessary for these corrections.
7. Lane fixtures now create fresh unique state beneath `.loopy/quality-tests`, with explicit `.loopy/loopies` project markers. Test commands inject synthetic HOME/XDG directories, disable env-file loading and unset the real-Docker opt-in. TMPDIR was never overridden.

## Signatures and ownership

- Owned: `ArtifactReader.read(plan, path)`, `AttemptExports.read(record, request)`, `AttemptAdmissions.monitor(record, request?)`, `SandboxAttemptAuthority.exportGuards(input)` and its FS/HTTP/DO implementations.
- Existing combined `recoverable` contract remains intact.
- No changes to native executor files, readmodel/summary fixtures, scripts/playground, README or AGENTS by this lane. No fixture adaptations were required outside the allowed lane. Focused TypeScript checking also included every architecture-docker fixture to catch interface fallout.

## Validation

All test commands ran from the checkout with this literal environment prefix, with the session directories created beforehand:

```sh
env -u LOOPY_SANDBOX_DOCKER_CONTEXT HOME="$PWD/.loopy/quality-tests/persistence-session-20261023/home" XDG_CONFIG_HOME="$PWD/.loopy/quality-tests/persistence-session-20261023/xdg-config" XDG_CACHE_HOME="$PWD/.loopy/quality-tests/persistence-session-20261023/xdg-cache"
```

Append the following commands to that prefix:

```sh
bun --no-env-file test --timeout 60000 packages/loopy/_tests_/sandbox-authority-*.test.ts packages/loopy/_tests_/cloud-sandbox.test.ts
bun --no-env-file test --timeout 60000 packages/loopy/_tests_/cloud-receipt-authority.test.ts packages/loopy/_tests_/cloud-receipt-export.test.ts packages/loopy/_tests_/cloud-receipt-recovery.test.ts packages/loopy/_tests_/cloud-receipt-results.test.ts
bun --no-env-file test --timeout 60000 packages/loopy/_tests_/cloud-receipt-http.test.ts
```

- Final sandbox run: exit 0, **34 pass, 1 skip, 0 fail**, 1,540 assertions. The skipped case requires real Docker and was intentionally disabled. Existing independent authority-model replay still reports depth 7, 56 states, 702 transitions and 55 filesystem traces.
- Receipt authority/export/recovery/results: exit 0, **14 pass, 0 fail**, 82 assertions. Ephemeral Miniflare servers use port 0 and isolated DO/R2 storage.
- HTTP suite: **4 pass, 1 fail**, `ECONNRESET` at `cloud-receipt-http.test.ts:55` on the second `getWorker("cloud").fetch` credential rejection, within Miniflare's `/cdn-cgi/platform-proxy`. Reproduced in an independent copy of HEAD source extracted with `git archive HEAD apps/cloud/src apps/sandbox/src packages/loopy/src packages/loopy/_tests_/cloud-receipt-http.test.ts`, using the isolated current receipt fixture. The baseline command was `bun --no-env-file test --timeout 60000 ./.loopy/quality-tests/persistence-session-20261023/baseline-http-copy/packages/loopy/_tests_/cloud-receipt-http.test.ts` with the same prefix. It produced the same 4 pass/1 fail and same line/error. No HTTP test or transport production edit remains. Root owns any follow-up to this preexisting runtime failure.
- `bunx tsc --noEmit -p .loopy/quality-tests/persistence-session-20261023/tsconfig.json`: exit 0, no output. Disposable config extended the root tsconfig, used `include: []`, and explicitly listed the 15 changed source files, cloud-sandbox, every sandbox-authority/cloud-receipt test, and every architecture-docker fixture, checking their imported dependencies.
- Scoped Biome and ESLint: exit 0. Biome printed `Checked 23 files in 32ms. No fixes applied.` ESLint printed nothing. Exact file selection below.
- `git diff --check -- <the same 23 files>`: exit 0, no output.

```sh
bunx biome check apps/sandbox/src/{admission,artifacts,attempt-admissions,attempt-exports,attempts,filesystem-authority,filesystem-journal,http-authority,receipts}.ts apps/cloud/src/receipts{,-authority,-identity,-sql}.ts packages/loopy/src/contract/sandbox-journal{,-rpc}.ts packages/loopy/_tests_/sandbox-authority-{publication,contract}.test.ts packages/loopy/_tests_/cloud-receipt-{recovery,export}.test.ts packages/loopy/_tests_/fixtures/{sandbox-authority,receipt-harness,receipt-recovery-probe}.ts packages/loopy/_tests_/cloud-sandbox.test.ts
bunx eslint apps/sandbox/src/{admission,artifacts,attempt-admissions,attempt-exports,attempts,filesystem-authority,filesystem-journal,http-authority,receipts}.ts apps/cloud/src/receipts{,-authority,-identity,-sql}.ts packages/loopy/src/contract/sandbox-journal{,-rpc}.ts packages/loopy/_tests_/sandbox-authority-{publication,contract}.test.ts packages/loopy/_tests_/cloud-receipt-{recovery,export}.test.ts packages/loopy/_tests_/fixtures/{sandbox-authority,receipt-harness,receipt-recovery-probe}.ts packages/loopy/_tests_/cloud-sandbox.test.ts
```

### Causal checks

- The artifact test injects a result reader that throws `Terminal result storage unavailable`. Ordinary lookup rejects; artifact export succeeds, observes a live guard during the read, calls cleanup and leaves no active guard.
- The admission test seeds 201 unrelated started records and 201 unrelated terminal records after startup, then admits/completes/looks up a new attempt. No combined recovery queries occur during admission; exactly one export query targets its volume.
- FS export pagination sorts mixed-case tokens consistently with SQLite, pages without receipt reads even after corresponding fixture receipts are removed, filters an exact volume, and preserves the combined recovery rejection for those invalid admitted-workspace links.
- The real workerd recovery probe retains 1,001 terminal and 1,000 released export records, adds 201 started records, and verifies export-only discovery plus exact/nonmatching volumes. EXPLAIN confirms active-export and exact-volume indexes. The HTTP export test verifies paging, exact-volume filtering and exclusion of released guards.
- Disposable Bun test bundles altered source only through build-time `onLoad` plugins, never production-file mutation. `bun --no-env-file test ./.loopy/quality-tests/persistence-session-20261023/artifact-result/sandbox-authority-publication.test.js --test-name-pattern 'artifact export uses terminal authority'` intentionally failed with `Terminal result storage unavailable` when the removed GET was restored. The matching `admission-history/...` command with pattern `'new admission reconciles only export metadata'` intentionally failed with expected recovery count 1 versus actual 3 when export reconciliation used combined recovery. Both exit 1, one causal failure each.
- Early test runs exposed scripted test-file mistakes. Original tests were restored before the final runs. No existing test was moved or deleted.

## Delta and handoff

Source: **+240 / -169**, net +71 lines across 15 files. Tests/fixtures: **+293 / -13**, net +280 across 8 files. The added typed query and two persistence adapters account for the net source growth; admission itself is smaller. No generic framework or state-machine redesign. No tests moved/deleted. No full check/build, architecture workload, Docker or external provider acceptance was run; root owns integration/fullcheck.

All owned disposable session state and baseline/negative-control copies were removed after validation. No successful test dataset is retained. Source is frozen after this report.

Source-only binary diff SHA-256, using the following file order: `58b0dc108eaa5ddd7926a900d48293a5b1a77190bd05487745c36778faa31b8f`.

- `apps/sandbox/src/admission.ts`
- `apps/sandbox/src/artifacts.ts`
- `apps/sandbox/src/attempt-admissions.ts`
- `apps/sandbox/src/attempt-exports.ts`
- `apps/sandbox/src/attempts.ts`
- `apps/sandbox/src/filesystem-authority.ts`
- `apps/sandbox/src/filesystem-journal.ts`
- `apps/sandbox/src/http-authority.ts`
- `apps/sandbox/src/receipts.ts`
- `apps/cloud/src/receipts.ts`
- `apps/cloud/src/receipts-authority.ts`
- `apps/cloud/src/receipts-identity.ts`
- `apps/cloud/src/receipts-sql.ts`
- `packages/loopy/src/contract/sandbox-journal.ts`
- `packages/loopy/src/contract/sandbox-journal-rpc.ts`
