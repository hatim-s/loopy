# Query correction

Implemented against branch `cloud-integration`, starting HEAD `9d30ca923d168e299099758e0d95f3db3ba81cf0`. Read AGENTS.md, unslop, typescript-codebase-craft and its TypeScript, testing and architecture references, runtime-data-opus finding 3, runtime-data-sol and TRIAGE.md.

Removed the unused `DashboardReader.runCounts` contract and its memory/SQLite implementations. `runCountsByDefinition`, `emptyRunCounts`, overview aggregation, query filters and persistence operations retain their implementations. No transaction, owner, attempt, receipt or dispatch behavior changed.

Updated the remaining assigned callers:

- `fixtures/readmodel-history.ts` derives per-definition and global-slug expected counts from individual `queryRuns` records, traversing two-record keyset pages. It never derives expected values from grouped rows. Existing assertions still check each status, workspace/slug identity, global shared slug, distinct separator-containing identities, positive unique groups, transition totals and rollback cursor preservation.
- `fixtures/readmodel-copied-data.ts` derives expected counts from its existing raw `SELECT id,workspace,slug,status FROM runs ORDER BY id` snapshot. Removed its duplicate grouped SQL oracle. It compares grouped results for all runs, each workspace/slug identity, each slug globally and each workspace, with all statuses represented. Its retained-database runner was compiled only.
- `fixtures/cloud-pagination-probe.ts` reports the known 205 seeded runs independently of the count implementation. The existing pagination test still checks all 205 expected ids, uniqueness, every pending-hook association, page boundaries and waiting filters.
- `dashboard-queries.test.ts` checks the absent slug through the supported overview query, retaining fractional windows and zero-filled buckets.

No tests were moved or deleted. No new test files were added. No files outside the seven assigned source/test files and this report were edited by this lane. The service lane removed `SummaryCountsStore.runCounts` in `fixtures/summary-service.ts`; I did not edit that file. Final `rg -n '\brunCounts\b' packages apps` returned no matches, so there are no remaining caller changes for root.

Validation used a disposable source snapshot at `.loopy/quality-tests/queries-uqlk1t24/project`. Only `packages/loopy/src`, `packages/loopy/_tests_`, `apps/cloud/src`, package manifests and the TypeScript config were copied. Dependency directories were symlinked. The copy had explicit `.loopy/loopies` markers and empty injected homes. Its architecture-test directory and every temporary database remained underneath the fresh quality-test root. There was no retained-data access. No source-importing checks were run against personal state. Only ephemeral Miniflare servers on port 0 were started and disposed.

Every runtime test/control command below used this process-local prefix, from that disposable project directory:

```sh
env -i PATH="$PATH" \
  HOME="/Users/hatim.shakir/projects/loopy/cloud-integration/.loopy/quality-tests/queries-uqlk1t24/project/home" \
  LOOPY_HOME="/Users/hatim.shakir/projects/loopy/cloud-integration/.loopy/quality-tests/queries-uqlk1t24/project/loopy-home" \
  XDG_CONFIG_HOME="/Users/hatim.shakir/projects/loopy/cloud-integration/.loopy/quality-tests/queries-uqlk1t24/project/home/config" \
  XDG_CACHE_HOME="/Users/hatim.shakir/projects/loopy/cloud-integration/.loopy/quality-tests/queries-uqlk1t24/project/home/cache" \
  TMPDIR="/Users/hatim.shakir/projects/loopy/cloud-integration/.loopy/quality-tests/queries-uqlk1t24/project/tmp" \
  DO_NOT_TRACK=1
```

No global TMPDIR was set and no legacy sandbox tests were run.

Commands and results:

```sh
bun --no-env-file test --timeout 60000 packages/loopy/_tests_/dashboard-queries.test.ts packages/loopy/_tests_/readmodel-counts.test.ts packages/loopy/_tests_/readmodel-scopes.test.ts packages/loopy/_tests_/readmodel-workerd.test.ts
# 18 pass, 0 fail, 7973 expect() calls.

bun --no-env-file test --timeout 60000 packages/loopy/_tests_/cloud-worker.test.ts --test-name-pattern 'workerd run pages retain all pending hooks'
# 1 pass, 10 filtered out, 0 fail, 1241 expect() calls.

bun --no-env-file ../negative-controls.ts
# Base bundle: 2 pass, 0 fail, 260 expect() calls, exit 0.
# Missing status grouping: 0 pass, 2 fail, exit 1, expected rejection.
# Missing workspace grouping: 0 pass, 2 fail, exit 1, expected rejection.

bunx --no-install tsc --noEmit -p tsconfig.queries.json
# Exit 0, no output. Repeated after the final semantic dashboard test edit, same result.

bun --no-env-file build --target bun packages/loopy/_tests_/fixtures/readmodel-copied-data.ts --outfile ../copied-data-compile-only.js
# Bundled 166 modules in 22ms, 0.89 MB entry point. Never executed.

bun --no-env-file test --timeout 60000 packages/loopy/_tests_/dashboard-queries.test.ts
# After the overview query reuse edit: 11 pass, 0 fail, 87 expect() calls.
```

The scoped TypeScript config extends the copied root config and includes core/queries.ts, memory-query-runs.ts, sqlite/query-runs.ts, dashboard-queries.test.ts, fixtures/readmodel-history.ts, fixtures/readmodel-copied-data.ts, fixtures/cloud-pagination-probe.ts, readmodel-counts.test.ts and fixtures/readmodel-assertions.ts. It follows their imports but excludes unrelated test entrypoints.

The negative-control script built three Bun test bundles from the disposable `readmodel-counts.test.ts`. A build plugin changed only the bundle inputs. For the status control it replaced SQLite `GROUP BY workspace,slug,status` with `GROUP BY workspace,slug`, and the memory key `[workspace, slug, status]` with `[workspace, slug]`. Both stores failed the claim-stage expected status totals. For the workspace control it used SQLite `GROUP BY slug,status` and memory key `[slug, status]`. Both stores failed the independent per-workspace comparison at the create stage. The same bundle pipeline without mutations passed. Its directory fixture was replaced in bundle inputs with an explicit disposable path. Shared production source was never mutated for these controls.

The first copied test run had 7 passes and a dashboard import failure because the package-local `oxc-parser` dependency directory was missing from the copy. Added its dependency symlink and reran successfully. A later ESLint run caught one missing blank line after extracting the shared overview query object. Added the blank line and reran scoped lint successfully. These were setup/style failures, not product test failures.

Final lint commands, run against the seven edited files in the shared checkout:

```sh
bunx --no-install biome check packages/loopy/src/core/queries.ts packages/loopy/src/store/memory-query-runs.ts packages/loopy/src/store/sqlite/query-runs.ts packages/loopy/_tests_/dashboard-queries.test.ts packages/loopy/_tests_/fixtures/readmodel-history.ts packages/loopy/_tests_/fixtures/readmodel-copied-data.ts packages/loopy/_tests_/fixtures/cloud-pagination-probe.ts
# Checked 7 files in 5ms. No fixes applied. Exit 0.

bunx --no-install eslint packages/loopy/src/core/queries.ts packages/loopy/src/store/memory-query-runs.ts packages/loopy/src/store/sqlite/query-runs.ts packages/loopy/_tests_/dashboard-queries.test.ts packages/loopy/_tests_/fixtures/readmodel-history.ts packages/loopy/_tests_/fixtures/readmodel-copied-data.ts packages/loopy/_tests_/fixtures/cloud-pagination-probe.ts
# Exit 0, no output.

git diff --check
# Exit 0, no output.
```

Delta relative to starting HEAD, excluding this report:

- Production: 0 added, 30 deleted. core/queries.ts -1, memory-query-runs.ts -13, sqlite/query-runs.ts -16.
- Tests/fixtures: 64 added, 25 deleted. dashboard-queries.test.ts +5/-3, cloud-pagination-probe.ts +1/-4, readmodel-copied-data.ts +23/-10, readmodel-history.ts +35/-8.
- Combined: 64 added, 55 deleted. The extra test lines replace the deleted production oracle with independent page/raw-row checks.

Final owned-file SHA-256 pins:

```text
c1c165637619d8e3c2ce7650e549c64ad42b81af301568bea64f2ee4eba53102 packages/loopy/src/core/queries.ts
7045924392a8f96b8bf88e4fe9ec3420ce22e1326d4e9f9215d2102d1bb139ab packages/loopy/src/store/memory-query-runs.ts
36a04eb9baf99a27269514550953208d1ad25ca2eaa7d92351818135f6585ef2 packages/loopy/src/store/sqlite/query-runs.ts
547042dfb9d5d78a5ed4f2aec957c4442df617333039680985f2ad72b8d91187 packages/loopy/_tests_/dashboard-queries.test.ts
a68c74c7c52f48fbbb20b701d97bbb0b51088cf1fb363b5a7819099014e2a417 packages/loopy/_tests_/fixtures/readmodel-history.ts
0c5c2150e9ad6d1a1e815568523bddea0ee187f34e1cb06a63571feea6bdc69c packages/loopy/_tests_/fixtures/readmodel-copied-data.ts
29b61f623fba90a0aeb65cfc1ea0fe1fdda0ebab9f6e6d2def752e2c142bdb9f packages/loopy/_tests_/fixtures/cloud-pagination-probe.ts
```

Root owns integration and full checks. These results cover the disposable query-lane snapshot, before all sibling changes were integrated. No full check, children, commits, pushes, cloud calls, Docker launches, existing-service actions, personal state access or historical evidence changes occurred. The disposable quality-test directory was removed after verification. Owned source is stable at the pins above.
