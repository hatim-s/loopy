# Authority test cleanup

Confirmed and fixed the combined-suite cleanup leak. Only these four files changed in this follow-up:

- `packages/loopy/_tests_/fixtures/sandbox-authority-lifecycle.ts`
- `packages/loopy/_tests_/sandbox-authority-lifecycle.test.ts`
- `packages/loopy/_tests_/sandbox-authority-publication.test.ts`, imports and hook registration only
- `packages/loopy/_tests_/sandbox-authority-delayed.test.ts`

## Cause and change

The shared fixture registered `afterEach` as a module import side effect. Bun cached that module across the three test files, leaving cleanup registered only for the first importing file. In the observed lifecycle/publication/delayed order, lifecycle's four fixtures were cleaned, while publication's six and delayed's two remained despite all tests passing.

The fixture now exports the existing cleanup body. Each test file imports it and explicitly registers `afterEach(cleanup)`. Cleanup still closes tracked Attempts services before removing their tracked roots. Fixture allocation, close behavior, assertions and production behavior are unchanged. No new cleanup abstraction or test was added.

The persistence owner confirmed publication export-query assertions were complete and reserved its two import lines and hook registration for this change. The owner held off authority test launches during the census and received the release after both corrected runs. All three test bodies were compared with pre-edit snapshots and are byte-for-byte unchanged. `fixtures/sandbox-authority.ts` retained its pre-task SHA256.

## Combined-suite reproduction

Used fresh verification root `.loopy/quality-tests/cleanup-authority-verification-tx6q0w57`. Its `run.py` captures direct-child `authority-*` names and directory modification times before and after the actual combined command. It reads no old dataset contents. Its subprocess environment replaces inherited variables with a fixed PATH and fresh HOME, LOOPY_HOME and XDG directories beneath this verification root, plus CI and disabled Cloudflare metrics. Bun uses `--no-env-file`. TMPDIR and real-Docker opt-ins are not set.

The actual subprocess command, with absolute paths, was:

```sh
bun --no-env-file test --timeout 60000 \
  /Users/hatim.shakir/projects/loopy/cloud-integration/packages/loopy/_tests_/sandbox-authority-lifecycle.test.ts \
  /Users/hatim.shakir/projects/loopy/cloud-integration/packages/loopy/_tests_/sandbox-authority-publication.test.ts \
  /Users/hatim.shakir/projects/loopy/cloud-integration/packages/loopy/_tests_/sandbox-authority-delayed.test.ts
```

Before the fix, this command exited 0 with `12 pass`, `0 fail`, `85 expect() calls`. Census increased from **43 to 51**, with eight fresh roots:

```text
authority-1fMRsu
authority-AYJmAj
authority-GVYo0p
authority-QAbVpL
authority-gBW73L
authority-iT0LvV
authority-uzAfJE
authority-zSrvyt
```

Only those eight newly created reproduction roots were removed after the subprocess exited. Each had an explicit `.loopy/loopies` marker. The original 43 names and directory modification times matched the initial census afterward. No old authority directory was cleaned.

After the fix, the same command exited 0 with `12 pass`, `0 fail`, `85 expect() calls`. Census was **43 to 43**, with zero fresh directories, zero missing old names and zero changed old directory modification times.

Repeated the combined command in reversed file order, delayed/publication/lifecycle. It again exited 0 with `12 pass`, `0 fail`, `85 expect() calls`, and census **43 to 43**, with zero fresh directories and unchanged old names/modification times. This checks both first-import orders against the original module-caching failure.

Exact commands used to orchestrate and capture these runs:

```sh
python3 .loopy/quality-tests/cleanup-authority-verification-tx6q0w57/run.py before
python3 .loopy/quality-tests/cleanup-authority-verification-tx6q0w57/run.py after
python3 .loopy/quality-tests/cleanup-authority-verification-tx6q0w57/run.py repeat
python3 .loopy/quality-tests/cleanup-authority-verification-tx6q0w57/run.py lint
python3 .loopy/quality-tests/cleanup-authority-verification-tx6q0w57/run.py types
```

`before-census.json`, `after-census.json`, `repeat-census.json` and matching logs remain in that new verification root for root inspection. The verification root uses a different prefix and is excluded from the authority fixture census.

## Scoped checks and delta

- Biome checked the four listed files, exited 0 and printed `Checked 4 files in 3ms. No fixes applied.` Actual command was `bun --no-env-file <root>/node_modules/@biomejs/biome/bin/biome check <four absolute file paths>`.
- ESLint checked the same paths with `bun --no-env-file <root>/node_modules/eslint/bin/eslint.js <four absolute file paths>`, exited 0 and printed no diagnostics.
- `bun --no-env-file <root>/node_modules/typescript/bin/tsc --noEmit -p <verification-root>/tsconfig.focused.json` exited 0 with no diagnostics. The focused config extends the repository tsconfig and includes only these four files and their imported dependencies.
- `git diff --check -- <four listed files>` exited 0 with no output.
- No broad check, source edit, Docker command, service action, cloud call or personal-state access. No children, commits or pushes. The existing 43 authority directories remain for root provenance.

Relative to the pre-follow-up snapshots, fixture delta is +2/-3 and each test-file registration delta is +4/-2. Total **+14/-9**, net +5 lines. Production-source delta is +0/-0. No tests or assertions were added, deleted or moved. `owned-delta.json` records per-file hashes. The four owned files are stable for root integration.
