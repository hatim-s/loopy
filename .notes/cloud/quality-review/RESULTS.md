# Quality cleanup results

Status: complete. All accepted fixes passed final repository checks, bounded Docker/DO proof and retained-stack verification. Main remains at 9d30ca923d168e299099758e0d95f3db3ba81cf0. Quality changes are confined to the cloud-integration worktree.

Six independent reviews, three Sol 6.1 and three Opus 5.5 at Standard speed, examined persistence, runtime/data, and tests/tooling. They found improved core boundaries, no demonstrated production correctness blocker in the reviewed range, and concrete maintenance costs worth removing. All reports remain here. TRIAGE.md separates accepted changes from broader proposals.

## Changes

- Local service now extends the portable service rather than forwarding every operation. Definition absence is nullable in the registry contract and becomes 404 centrally. Corruption remains an error. Direct native graph and secret methods now return promises.
- Removed the unused filtered runCounts contract and implementations. Grouped counts and overview semantics remain. Tests derive reference counts independently.
- Summary projection serialization is compiler-checked for required fields and shares the graph input presentation rule. Serialized layout and row byte budgets remain.
- Artifact export reads the finished authority record without fetching result bytes it never uses. Lookup still verifies results. Ordinary admission queries export guards rather than enumerating unrelated attempt history. Shared identity derivation preserves durable names and hashes. Admission control flow retains ambiguous-acknowledgement and same-session first-start obligations.
- The default queue test no longer pins 467 historical source hashes. Its queue assertions remain. Three matching workerd test fixtures share a small helper, and successful queue-test state is removed after shutdown.
- Documentation describes storage modes, the optional filesystem-default dependency factory, bindings, sessions, export guards and retained-data exit conditions. Test-isolation guidance has one owner.

No existing test was deleted or moved. Historical evidence, retained datasets, both playground modes and necessary receipt decoding remain.

## Verification so far

Implementation lanes passed focused checks and causal negative controls. Fresh service/data, persistence and tooling reviews approved their scoped candidates. Documentation recommendations from the tooling review were addressed. Reviews were static unless their reports say otherwise.

The integrated command is bun --no-env-file run check with fresh synthetic HOME, LOOPY_HOME and XDG directories. TMPDIR is left at the OS default. Docker is opt-in and excluded from this command.

- Attempt 1 stopped on formatting of a new evidence receipt. The receipt was formatted.
- Attempt 2 passed build, lint and types, then had one SSE unread-client close timeout: 1,287 passed, four skipped, one failed. Both SSE pressure/reconnect cases then passed unchanged in isolation, two tests and 538 assertions. The receipt HTTP suite passed in this integrated run; an earlier focused ECONNRESET also reproduced against the starting commit.
- Attempt 3 passed build, lint, types and 1,289 tests, with three expected skips and zero failures. A harmless synthetic .zshrc enabled the home-read sandbox test without touching personal files. All 56 candidate source/test hashes matched before the run. This pass precedes the final small persistence trim and fixture-cleanup correction.

Full logs and failed attempts are retained in the isolated quality-test roots. fullcheck-1.json, fullcheck-2.json and fullcheck-3.json identify them. A passing rerun does not prove the SSE timing test is free of intermittent failures.

## Final corrections and check

The unused no-volume export query is removed. Volume-scoped reconciliation receives an explicit blocked result; startup still uses combined recovery and retains its prior cleanup policy. Root inspected the final narrow diff against the approved round-two candidate.

The shared fixture registered afterEach during import, which Bun cached across three test modules. A combined run reproduced eight leaked directories despite twelve passing tests. Each test module now registers the unchanged cleanup function explicitly. Both test orders passed with zero fresh leaks. Old 43 directories remain untouched.

Final bun --no-env-file run check passed build, lint, typechecks and **1,289 tests, three expected skips, zero failures**, 671,309 assertions across 112 files. Authority-directory names/count stayed exactly 43 before and after. All final candidate source/test hashes stayed unchanged. fullcheck-final.json identifies the log and source-final.json pins the candidate.

Production delta against 9d30ca9 is **+300/-348 lines**, net -48. Tests/fixtures are **+608/-260**, net +348. Maintained docs are **+105/-28**. Reports and evidence are counted separately. No test was moved or deleted; assertions for the deliberately removed unused query mode were removed with that mode.


## Limits and follow-up

This is code-quality acceptance, not a new throughput benchmark or remote cloud validation. The 525-cloud/45-daemon workload results belong to the preceding architecture candidate. Live R2 amplification and active-load tail attribution remain unresolved there.

Broader adapter-model equivalence, permanent monitor-rejection handling, unified result-size policy, native child-boundary simplification, manual-proof relocation and profile redesign were deliberately not changed. Their semantics or retained-data requirements need separate work. The filesystem beginExport scan of attempt receipts predates this correction and remains.

No cloud operations, personal-data migration, main edits or pushes occurred in this quality pass. The retained architecture stack was stopped before edits and restored after verification. All 528 run IDs/statuses match the prior inventory. Personal listener PIDs 90523 and 41194 remain unchanged.

## Final runtime acceptance

One invocation of the existing architecture-docker-proof.ts passed all seven scenarios in 23.003 seconds with four sequential workers and five attempt identities. It used fresh local workerd/SQLite/R2 state and the existing pinned architecture image. No image build, pull, remote action or retained-workload admission occurred. Receipt/export/admission code came from the final candidate; the unchanged image is the prior compiled worker image.

The proof covers duplicate/lost-ack admission, storage reconstruction, export-guard exclusion and recovery, actual worker kill/deadline, and outage shutdown. It reported no source drift or cleanup errors. Root independently checked all 15 exact possible container names, nine volumes, the source-defined owner label and both lock paths. None remained. An initial post-check guessed an input-helper prefix and lock path; the receipt records corrected source-derived names and successful rechecks. This does not establish remote-provider or power-loss guarantees.

Commands after the full check:

```sh
LOOPY_ARCHITECTURE_DOCKER_GATE=root-runtime-stable \
LOOPY_ARCHITECTURE_DOCKER_IMAGE=loopy-sandbox:architecture-bun-1.4.0 \
LOOPY_ARCHITECTURE_DOCKER_IMAGE_ID=sha256:ffc247b1e3a93dc0eafb8f387ed52d5b8fc7445e929a701f2117f6a0cc175722 \
bun --no-env-file packages/loopy/_tests_/fixtures/architecture-docker-proof.ts
LOOPY_PLAYGROUND_PROFILE=architecture bun --no-env-file scripts/playground/index.ts start
LOOPY_PLAYGROUND_PROFILE=architecture bun --no-env-file scripts/playground/index.ts status
LOOPY_PLAYGROUND_PROFILE=architecture bun --no-env-file .loopy/quality-tests/verify-restored-stack.ts
```

The restored API, sandbox and dashboard returned HTTP 200. Three authenticated run pages, 200/200/128, exactly matched all 528 prior IDs/statuses: 464 successes and 64 expected failures. No new playground runs were created. Dashboard: http://127.0.0.1:15272. Private authentication stays in the retained generated dashboard.url. Supervisor PID 55911 owns this restored stack; use the recorded identity-checked stop command.

Final receipts: fullcheck-final.json, source-final.json, docker-proof-final.json, docker-cleanup-final.json, restored-stack.json and protected-services-final.json. Earlier failures remain recorded and are not replaced by final success. Cleanup is kept on cloud-integration; main remains 9d30ca9 and no push occurred.
