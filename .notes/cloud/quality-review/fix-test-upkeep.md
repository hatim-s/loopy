# Test upkeep correction

Implemented on `cloud-integration`, starting at `9d30ca923d168e299099758e0d95f3db3ba81cf0`. Read both tests-tooling reviews, TRIAGE.md, AGENTS.md, unslop, typescript-codebase-craft and its tests and TypeScript references. No children, commits or pushes.

## Changes

- Removed the historical source-freeze reader, 467-file expectation, aggregate expectation and before/after manifest comparisons from the default queue test. All provider-hold, control-workspace, pending-read, result, history and admission assertions remain. The built bundle hash remains diagnostic information only.
- The queue suite now removes its exact fresh directory after success. Failure retains `evidence.json` and prints the directory path after runtime/provider teardown. Successful runs no longer retain an evidence file.
- Set the queue fixture's `modulesRoot` explicitly to its bundle directory. Running from `packages/loopy` had exposed a Miniflare startup failure when its implicit module root required traversing above cwd. Both cwd variants now pass.
- Added `fixtures/workerd-probe.ts` for exactly the three PROBES users: definition summaries, read-model workerd and summary size. Its explicit typed options name the entry, Worker name, Durable Object class and optional BUCKET binding. It shares build, startup, request, eviction and cleanup behavior. SQL persistence, R2 binding names and persistence, named instances, eviction targets and response parsing as unknown remain intact. The read-model runtime still has no R2 binding.
- Added `fixtures/quality-test-root.ts` for these fixtures and the queue suite. It derives `.loopy/quality-tests` from the fixture's location, allocates a unique child and creates an explicit `.loopy/loopies` marker. Runtime directories contain generated bundles and isolated state. They do not contain application source.
- All three probe builds now fail on unsuccessful builds or nonempty build logs. The two test-file implementations already required empty logs; this also makes the size fixture reject build warnings. Failed build/startup paths dispose any constructed runtime and remove their exact owned directory.

The provider fixture needed no change. No production source was edited by this lane. The receipt harness, existing shared read-model assertions, copy runner, model oracles, manual proof programs, legacy persisted-data support and historical evidence remain outside this patch. `readmodel-directory.ts` remains because its native SQLite suites still use it.

The service lane separately changed the absent-get assertion in `definition-summaries-workerd.test.ts`. My edits there stop before `const summaryResult`. The projection lane separately added the JSON-root case in `definition-summary-size.test.ts`. I made no edits to that file.

## Validation

All test subprocesses used a replacement environment containing only a fixed PATH, fresh HOME, LOOPY_HOME, XDG_CONFIG_HOME and XDG_CACHE_HOME under the verification directory, `CLOUDFLARE_SEND_METRICS=false` and `CI=1`. Commands used `bun --no-env-file`. TMPDIR was not set. Only isolated local Bun/Miniflare servers on port 0 were started.

Verification directory: `.loopy/quality-tests/test-upkeep-verification-c1tzx0gf`. Its `run.py`, `queue-controls.py`, focused tsconfig, logs and `owned-delta.json` record exact arguments and results. These are new disposable diagnostics, not historical evidence.

Commands below ran from the repository root unless stated otherwise:

```sh
python3 .loopy/quality-tests/test-upkeep-verification-c1tzx0gf/run.py root
python3 .loopy/quality-tests/test-upkeep-verification-c1tzx0gf/run.py package
python3 .loopy/quality-tests/test-upkeep-verification-c1tzx0gf/run.py lint
python3 .loopy/quality-tests/test-upkeep-verification-c1tzx0gf/run.py types
python3 .loopy/quality-tests/test-upkeep-verification-c1tzx0gf/queue-controls.py
python3 .loopy/quality-tests/test-upkeep-verification-c1tzx0gf/verify-final.py
```

`run.py root` and `run.py package` each invoke this exact suite set with absolute paths; the latter changes subprocess cwd to `packages/loopy`:

```sh
bun --no-env-file test --timeout 60000 \
  /Users/hatim.shakir/projects/loopy/cloud-integration/packages/loopy/_tests_/workspace-read-queue.test.ts \
  /Users/hatim.shakir/projects/loopy/cloud-integration/packages/loopy/_tests_/definition-summaries-workerd.test.ts \
  /Users/hatim.shakir/projects/loopy/cloud-integration/packages/loopy/_tests_/readmodel-workerd.test.ts \
  /Users/hatim.shakir/projects/loopy/cloud-integration/packages/loopy/_tests_/definition-summary-size.test.ts
```

Both final invocations exited 0 and printed `21 pass`, `0 fail`, `2799 expect() calls`, across four files. Runtime was 3.15 seconds from root and 2.07 seconds from the package directory. Coverage includes legacy projection backfill, rollback, corruption, named-object eviction/reopening, scope page traversal, the 97/98/200 platform control, row budgets, R2 write counts and both queue hold modes.

For lint, the six owned files listed below were passed by absolute path to `bun --no-env-file <root>/node_modules/@biomejs/biome/bin/biome check` and `bun --no-env-file <root>/node_modules/eslint/bin/eslint.js`. Biome printed `Checked 6 files in 5ms. No fixes applied.` ESLint printed no diagnostics. Both exited 0. An earlier formatting invocation used Biome `check --write` on the same six paths and applied no fixes. Initial ESLint findings in the new helper were corrected before the final runs.

For types, `bun --no-env-file <root>/node_modules/typescript/bin/tsc --noEmit -p <verification-directory>/tsconfig.focused.json` exited 0 with no diagnostics. The config extends the repository tsconfig and includes only the six owned files, plus their transitive imports. No broad check, build, lint or typecheck script was run. Root owns integration and fullcheck.

The first suite run, during sibling edits, printed 19 pass and 2 fail. One failure was the service lane's old absent-get expectation; the other was the projection lane's new JSON input fixture temporarily using reject instead of passthrough. Their owners corrected them. The first package-cwd run printed 20 pass and 1 fail due to the queue module-root issue fixed above. These attempts are retained in `initial-root-0.log` and `before-modules-root-*.log`; final green results are in `root-0.log` and `package-0.log`.

## Disposable controls and cleanup

`queue-controls.py` copied the current queue test and its dependencies, package source, cloud Worker source and configuration into a new marked disposable directory. It linked node_modules for dependency reads and did not modify shared production files. It did not copy `.notes` or the historical manifest.

1. Appended a harmless comment to the copied `packages/loopy/src/engine/step.ts`. The queue test exited 0 with `1 pass`, `0 fail`, `46 expect() calls`. Its exact successful directory was gone afterward.
2. In the same disposable copy only, replaced `const pending = this.serial.then(work);` with `const pending = work();` in `apps/cloud/src/workspace.ts`. The test exited 1 with `0 pass`, `1 fail`, `11 expect() calls`. It failed at queue test line 159 because all three held-workspace reads returned HTTP headers before provider release. This is the pending-read invariant, not a historical hash failure.
3. The negative-control event file records cleanup release and `trial-resources-closed` for lookup. It has no `proof-passed` event. The path was explicitly printed. The test process completed, including provider server stop and runtime disposal.
4. Verified successful queue roots `read-queue-Wj9SAZ` and `read-queue-1shZb7` were deleted. No successful `summary-tests-*`, `summary-size-tests-*` or `readmodel-*` directories remained under this checkout's quality-tests root. The earlier successful queue roots were also gone. Removed the superseded owned control copy after the final control completed.
5. `git diff --exit-code -- .notes/cloud/evidence/architecture/source-freeze.json` exited 0. Before/after SHA256 matched `34369d678d2d9baf06841c5309e066c2e0b6aacf0d934d03c922d98bf73d682c`. `rg -n source-freeze packages apps scripts` had no matches.

Retained failure diagnostics are explicit:

- Final negative control: `.loopy/quality-tests/test-upkeep-verification-c1tzx0gf/queue-copy-final/.loopy/quality-tests/read-queue-wKU3bu/evidence.json`.
- Earlier package-cwd startup failure: `.loopy/quality-tests/read-queue-JoxQn2/evidence.json`.
- Verification scripts, focused logs and copied failing source remain under `.loopy/quality-tests/test-upkeep-verification-c1tzx0gf` for root inspection.

No existing services, Docker, cloud APIs, personal state, old `.loopy` datasets or historical captures were used or changed.

## Owned line delta and test inventory

Compared with the requested starting HEAD, excluding the service lane's separate assertion edits:

| File under packages/loopy/_tests_ | Added | Deleted |
| --- | ---: | ---: |
| workspace-read-queue.test.ts | 11 | 42 |
| definition-summaries-workerd.test.ts, harness only | 15 | 49 |
| readmodel-workerd.test.ts, harness only | 13 | 40 |
| fixtures/summary-size-runtime.ts | 10 | 56 |
| fixtures/workerd-probe.ts | 83 | 0 |
| fixtures/quality-test-root.ts | 12 | 0 |
| Total | 144 | 187 |

Net reduction: 43 lines. Production-source delta for this lane: +0/-0. No tests were added, deleted or moved. Four historical freeze assertions were removed. Behavioral queue assertions and read-model/size assertions were preserved. The three fixture implementations were consolidated without moving their tests.

Owned implementation is complete and stable for root integration. No further source edits are planned by this lane.
