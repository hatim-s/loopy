# Persistence final trim

Source stable. Branch remains `cloud-integration` at HEAD `9d30ca923d168e299099758e0d95f3db3ba81cf0`, with uncommitted changes. Read `persistence-review-2.md` and prepared read-only while root's full check ran. No writes or checks began until `ROOTEDIT`. Root reported the pre-trim full check exited 0 with 1,289 pass, 3 skip and 0 fail. This lane did not rerun a broad check.

## Exact correction

- `exportGuards` requires `volume` in its wire schema. The DO retains only its exact-volume, active-guard query. FS requires exact volume equality. Both retain the existing bounded cursor/limit shape; combined all-volume startup recovery remains `recoverable`.
- `reconcile(volume: string)` queries that volume and throws the existing conflict when cleanup reports blocked. `reconcileGuards(exports)` returns its blocked boolean and no longer accepts a hidden throw flag. Startup still ignores that return value, tolerates unresolved cleanup, and proceeds with attempt recovery. Existing failed-cleanup/restart coverage passes.
- Artifact export computes its attempt id once for the admission wait and authority read.
- The exact-volume query error now says `Export guard query returned a missing or inactive guard.` The combined recovery error is unchanged.
- Updated existing assertions to target volumes and cursor exhaustion. Removed only the unused all-volume query assertions and their probe output/EXPLAIN. Combined recovery paging, exact-volume exclusion, metadata-only FS discovery, release, missing-result export and admission-history coverage remain.

No new tests or helpers were added. No test was moved or deleted. Test names were updated to describe exact-volume discovery. Shared identity/resource helper signatures, transport scripts, model semantics, completion prechecks, legacy decoding, native receipts and every deferred reviewer preference remain unchanged. No outside-owner source edit was required.

## Coordination and scope

During the authority-directory census, no suite was launched by this lane. Publication assertion edits were complete before reserving that file's `bun:test` import, lifecycle import and one top-level `afterEach` registration for the cleanup lane. Those cleanup edits were preserved. The helper, lifecycle and delayed cleanup files were not edited by this lane. Focused suites resumed only after the census hold was released. Final test hashes below include the cleanup lane's publication imports/hook. The trim-only test diff hash was captured before those edits so the lane deltas remain attributable.

Only a fresh disposable session under `.loopy/quality-tests/persistence-final-9gffv_n4` was allocated for commands, synthetic HOME/XDG paths, the focused tsconfig and before/after snapshots. Existing fixtures create unique quality roots with project markers. TMPDIR was not changed. No services, Docker, cloud calls, existing datasets, old authority roots, commits or pushes were touched. Earlier reports/evidence were preserved. Owned session state was removed after recording this receipt; root owns the final directory census and integration/proof work.

## Checks and results

All focused test processes finished and their owned Miniflare/Bun servers were disposed before handoff. Test commands used this literal prefix from the checkout:

```sh
env -u LOOPY_SANDBOX_DOCKER_CONTEXT HOME="$PWD/.loopy/quality-tests/persistence-final-9gffv_n4/home" XDG_CONFIG_HOME="$PWD/.loopy/quality-tests/persistence-final-9gffv_n4/xdg-config" XDG_CACHE_HOME="$PWD/.loopy/quality-tests/persistence-final-9gffv_n4/xdg-cache"
```

Append each command to that prefix:

```sh
bun --no-env-file test --timeout 60000 packages/loopy/_tests_/sandbox-authority-*.test.ts packages/loopy/_tests_/cloud-sandbox.test.ts
bun --no-env-file test --timeout 60000 packages/loopy/_tests_/cloud-receipt-authority.test.ts packages/loopy/_tests_/cloud-receipt-export.test.ts packages/loopy/_tests_/cloud-receipt-recovery.test.ts packages/loopy/_tests_/cloud-receipt-results.test.ts
```

- Sandbox: exit 0, **34 pass, 1 skip, 0 fail**, 1,541 assertions, eight files. Real Docker was intentionally skipped. The unchanged authority model replay printed depth 7, 56 states, 702 transitions and 55 filesystem traces.
- Receipt authority/export/recovery/results: exit 0, **14 pass, 0 fail**, 78 assertions, four files. Exact-volume queries continue to use the active-volume index against terminal/released history plus 201 unrelated started records.
- `bunx tsc --noEmit -p .loopy/quality-tests/persistence-final-9gffv_n4/tsconfig.json`: exit 0, no output. The disposable config extended the root config with `include: []` and explicitly selected the original 15 persistence source files, cloud-sandbox, every sandbox-authority/cloud-receipt test, and every architecture-docker fixture, plus their imported dependencies.
- Final read-only formatting/lint commands below: exit 0. Biome printed `Checked 10 files in 18ms. No fixes applied.` ESLint printed nothing.

```sh
bunx biome check apps/sandbox/src/{attempts,attempt-exports,filesystem-authority}.ts apps/cloud/src/receipts-sql.ts packages/loopy/src/contract/sandbox-journal-rpc.ts packages/loopy/_tests_/sandbox-authority-{publication,contract}.test.ts packages/loopy/_tests_/cloud-receipt-{export,recovery}.test.ts packages/loopy/_tests_/fixtures/receipt-recovery-probe.ts
bunx eslint apps/sandbox/src/{attempts,attempt-exports,filesystem-authority}.ts apps/cloud/src/receipts-sql.ts packages/loopy/src/contract/sandbox-journal-rpc.ts packages/loopy/_tests_/sandbox-authority-{publication,contract}.test.ts packages/loopy/_tests_/cloud-receipt-{export,recovery}.test.ts packages/loopy/_tests_/fixtures/receipt-recovery-probe.ts
```

## Deltas and hashes

Relative to the reviewed round-2 snapshot, this trim changes five source files by **+23 / -33**, net -10, and five test/fixture files by **+23 / -49**, net -26. These counts exclude the separately owned publication cleanup-hook edits. There are no test moves/deletions. Replaced all-volume assertion blocks were for a removed contract mode; volume/cursor behavior remains covered.

Cumulative HEAD delta over the original 15 source files: **+237 / -176**, net +61. Over the original eight test/fixture files: **+271 / -15**, net +256, including the cleanup lane's publication edits.

Binary diff SHA-256 values use the same source/test file selections as the preceding persistence handoff and round-2 review.

| Selection | Before trim | Final |
| --- | --- | --- |
| source | `58b0dc108eaa5ddd7926a900d48293a5b1a77190bd05487745c36778faa31b8f` | `039cd7ac64a4274f391890fa3f32baf1baaf76dc06a5f05e2e6115ef2d3a6ea4` |
| tests | `4a428d574e907344fab59c102f41e54bf2f8e5a5ff876d572515a72c418e6ca4` | `2235a79156bc1227b83c4d786dfcf204136f632476e55d0855fd14fd3631f255` |

Trim-only test diff before the cleanup lane's import/hook edits: `b46032aed7a418ecd43beed01bcd09d622c16a5e2c9997610c8a1a9a5a8810c4`. Source hash did not change during that cleanup or focused validation.

Working-file SHA-256 at handoff:

```text
765e9a5603fbbd6eb150e412c1528e6e82fc27ddd2c6613f998c77eda4d52060  apps/sandbox/src/admission.ts
a97012f88b590da1c573755f76247742e8dd0b0a2136a15b77b80d17dba63489  apps/sandbox/src/artifacts.ts
743f2d1d2d4b415fcd7b93715eed0099f654e8f20365ea0a0ec96c5fe6cb8a21  apps/sandbox/src/attempt-admissions.ts
9652daaa6a663338f20649317240e8c4d5c1da3880c78b59b5363d864fc03081  apps/sandbox/src/attempt-exports.ts
6604952d0892a35bc26dd69b204523e3289d4f978299ba4fb415cf370389f0bb  apps/sandbox/src/attempts.ts
57a290c0003c539cf4e0537c1bedd5de97a2607a10cdd8eae43f2ab16e451a37  apps/sandbox/src/filesystem-authority.ts
c9cfe1ee2123f6b9f584ffbff0bc2e0fd7abe1237ada5b06c2bf2f628be15e54  apps/sandbox/src/filesystem-journal.ts
f69f136ea284537652a6e2590522d89c165af20b543ba3686a57ceb0ee35b4d4  apps/sandbox/src/http-authority.ts
e1ded94765a6b463ba2e5ca929fd8af1f6d7f3b59865457d0a4b3cbfc64b8f84  apps/sandbox/src/receipts.ts
ecb034a3549567267bcec208021799a255b2b819fc1075e453aa513904b38621  apps/cloud/src/receipts.ts
675c4e735463f5004d26fd9d5a96d543deebd453b376e1f03db3c436a1c6024b  apps/cloud/src/receipts-authority.ts
1e7be270dd52c42aa98d76f432afa87446ef0e4f72c99f423fe942357dfbef4f  apps/cloud/src/receipts-identity.ts
427ed320ebbe4336550ee9c0f246b8163ce12a4017730bfe1cfd5aab3a2f993a  apps/cloud/src/receipts-sql.ts
20617658c6bfbfebca2708a3ebf7f012e4f8fbc3021e46be3bf7f3abc0764cd4  packages/loopy/src/contract/sandbox-journal.ts
455e178d623d77b462bb03a98ecaaa8fd100aae68f235972d9081819ff62815e  packages/loopy/src/contract/sandbox-journal-rpc.ts
b7302b94b50a1b31e354d18f7162d8245923fad4c74c16766f7045c652f175ea  packages/loopy/_tests_/sandbox-authority-publication.test.ts
3cbe8298ba213066489a26712358cb3ab50df63aee8b664e14346a76a1531e80  packages/loopy/_tests_/sandbox-authority-contract.test.ts
d0beee067a4f583edeee57677371b21599e3cde6a834f96560a0c5ba8b5c8470  packages/loopy/_tests_/cloud-receipt-recovery.test.ts
c70308e01f4a7f44cad13be17cc05133ad48d4f6720df699704e9e917392ce18  packages/loopy/_tests_/cloud-receipt-export.test.ts
41640503c0cc4e92ea53b7157566a72d23202c3fd0faaba61ff4ef2b4cdb1119  packages/loopy/_tests_/cloud-sandbox.test.ts
f34b8c6a5fb304e17940d53855ffde8991903f31d87f88e8d7367e2fb840ae41  packages/loopy/_tests_/fixtures/sandbox-authority.ts
948a810661d2000ff03968ead75f1f75e83a4647aa4cb8934ad133942ddfebb5  packages/loopy/_tests_/fixtures/receipt-harness.ts
cb495b0d06d5bd814e6943da7d50298c0b7796244c3179a4e66bc24bdc834628  packages/loopy/_tests_/fixtures/receipt-recovery-probe.ts
```
