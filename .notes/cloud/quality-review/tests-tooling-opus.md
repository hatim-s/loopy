# Tests, tooling and navigability review

Reviewer: Opus 5.5, independent. I did not read other reviewers' reports, acceptance verdicts or the `*-review-*.md` notes. The only design note I read was `.notes/cloud/architecture/ownership.md`, and only after the source inspection, to explain the duplication described in T3.

## Pins

- Branch `cloud-integration`, HEAD `9d30ca923d168e299099758e0d95f3db3ba81cf0` (verified).
- Range `6ffecdfd60e16aaa335467684d918b3cd8b44813...9d30ca9`: `69de89c` (source and tests), `7f6976a` (evidence), `9d30ca9` (evidence).
- Line counts in the range: tests +8,782/-32, scripts +1,107/-343, production (`packages/loopy/src`, `apps/{cloud,sandbox}/src`) +4,146/-1,377, `.notes` +435,805. The one-off proof programs in `_tests_/fixtures` account for 1,503 of the test lines.
- `.notes` in the tree grew from 7.4 MB at `6ffecdf` to 23.1 MB at HEAD. All code under `packages`, `apps` and `scripts` is 3.9 MB.

## Verdict

The tests are mostly better than the codebase average. The sandbox authority and host policy model checks compare an independent oracle with the real implementation. The receipt suites run real workerd, R2 and Durable Object SQLite instead of mocks. The read-model assertions are shared across memory, SQLite and workerd. Test names describe behavior. Playground `stop` now proves PID, process group and launch nonce before signalling, and that check is tested through a parameter, not a module mock.

The tooling and repository layout got harder to read, though. One gated test now locks 467 production files to a hash list stored in `.notes`, so the next source edit fails `bun run check`. Hand-run proof programs sit in `_tests_/fixtures` and are typechecked and linted on every check. The workerd harness is copied three more times. Test temp roots now come in two styles. The playground carries a permanent second mode named after a one-off campaign, and campaign counts are wired into gated tests. About 15.7 MB of raw evidence went into git, split across two directory conventions, and lint config was loosened to fit it. AGENTS.md and the app READMEs were not updated for the new receipt authority, `service/` ownership, or the new gated test folder.

Overall: the test value went up, but navigability and tooling hygiene regressed. One correctness blocker (T1). The rest is valuable cleanup, and most of it is deletion.

## Findings

### Correctness blocker

**T1. A gated test fails on any edit to 467 source files.**
`packages/loopy/_tests_/workspace-read-queue.test.ts:50-73, 81-85, 234`

- Mechanism: the test reads `.notes/cloud/evidence/architecture/source-freeze.json` (line 58), asserts 467 entries and a fixed aggregate hash (81-84), then asserts that every listed file still matches its saved SHA-256, both before (85) and after (234) the trial. The list covers all 278 files in `packages/loopy/src`, 77 dashboard files, all of `apps/cloud/src`, `apps/sandbox/src`, `scripts/playground`, `scripts/daemon-playground` and `package.json`. The test is unconditional, and `package.json` `test` runs `packages/loopy/_tests_`.
- Before: no gated test read `.notes` or pinned source bytes. After: it passes at HEAD (I re-hashed all 467 files and found 0 mismatches), so the green final check proves nothing. The first change to `local/service.ts` or any dashboard component makes `bun run check` fail, and that includes the Sol fixes this review is meant to feed.
- Smallest fix: delete the `freeze` schema and read, `frozenChanges`, the three freeze expectations, and the `freeze` fields in the `proof-passed` record. Keep the queueing assertions, which are the real invariant. If source freezing matters for a measurement campaign, it belongs in the campaign script, not in `bun test`.
- Validation: run the single test file, then make a no-op edit to one frozen file in a scratch copy and confirm the test still passes. Grep `packages apps scripts` for `source-freeze` and expect no hits.

### Valuable cleanup, high value

**T2. Hand-run proof programs live in `_tests_/fixtures` and are checked on every run.**
`packages/loopy/_tests_/fixtures/architecture-docker-{proof,resources,runtime,scenarios}.ts` (1,164 lines), `packages/loopy/_tests_/fixtures/readmodel-copied-data.ts` (339 lines)

- Neither is a test or a fixture. No test imports them. `architecture-docker-proof.ts:324` is an `import.meta.main` entry gated by `LOOPY_ARCHITECTURE_DOCKER_*` env (167-169). `readmodel-copied-data.ts` runs at module top level, creates `.loopy/architecture-tests` at import (line 31), hardcodes paths and SHA-256 hashes of two local diagnostic SQLite files (41-58, including `quiesced-postload-20261022T203547958718Z`), and writes `.notes/cloud/architecture/evidence/copied-data.json` (35). Nobody else can run it.
- Consequence: `tsc` and ESLint cover them, so every signature change in `apps/sandbox` or the store forces edits to 1,500 lines of one-off code. They also blur what `fixtures/` means.
- Fix: delete them. The evidence JSON already records the runner hash and base head, so git history keeps the exact program. If Hatim wants them rerunnable, move them to `scripts/architecture-proof/` and drop the hardcoded diagnostic hashes in favor of arguments.
- Validation: `bun run typecheck` and `bun run lint` pass, and `grep -r "architecture-docker\|readmodel-copied-data" packages scripts` finds nothing outside the moved folder.

**T3. The workerd probe harness was copied three more times.**
`packages/loopy/_tests_/definition-summaries-workerd.test.ts:16-52`, `packages/loopy/_tests_/readmodel-workerd.test.ts:13-49`, `packages/loopy/_tests_/fixtures/summary-size-runtime.ts:6-63`. Related builders: `fixtures/receipt-harness.ts:14-90`, `workspace-read-queue.test.ts:87-127`.

- Each copy creates a directory, runs `Bun.build` on one probe entry with the same `target/format/naming`, starts Miniflare with a single `PROBES` Durable Object and optional R2, and exposes `probe(instance, body)` plus dispose and remove. At baseline there were two `new Miniflare(` sites in tests. Now there are seven.
- `ownership.md` explains why: "Separate workerd tests avoid editing the existing broad cloud-worker fixture concurrently." That was a coordination constraint for parallel lanes. The lanes have merged, so the constraint is gone and the copies remain. They already disagree on temp roots (tmpdir in one, repo-local in two) and on build failure handling (`expect` in two, `throw` in one).
- Fix: one `fixtures/workerd-probe.ts` exporting `probeRuntime({ entry, className, r2 })` that returns `{ probe, evict, close }`. Migrate the three PROBES users. Leave `receipt-harness` alone; it runs three workers and a restart.
- Validation: the three suites pass, and the test line count drops by roughly 100.

**T4. Repo-local temp roots are copied about eight times and leak.**
`fixtures/readmodel-directory.ts:5`, `fixtures/summary-size-runtime.ts:7`, `fixtures/receipt-harness.ts:15-16`, `fixtures/local-receipts.ts:16-20`, `fixtures/architecture-docker-runtime.ts:81`, `workspace-read-queue.test.ts:38-41`, `scripts/playground/_tests_/receipt-inventory.test.ts:30`, `registry-isolation.test.ts:8`

- Before: tests used `mkdtemp(tmpdir())` (26 files still do). After: new tests resolve `../../../../.loopy/architecture-tests` by hand. `receipt-inventory.test.ts:30` uses a cwd-relative `resolve(".loopy/architecture-tests")`, so the location depends on where `bun test` runs. `registry-isolation.test.ts:8` creates its root inside `packages/loopy/_tests_` itself, so a crash leaves a dotted directory in the source tree.
- Leak: `workspace-read-queue.test.ts` never removes its directory. Line 238 writes `evidence.json` into it. Every `bun run check` leaves a `read-queue-*` directory under the repo's `.loopy` with a full worker bundle and two sets of DO and R2 persistence.
- `final-check.json` says only "new architecture fixtures use isolated worktree roots". I found no reason in the source why the read-model, summary or local-receipt tests need a worktree path. The Docker proof may need one for Colima mounts, which I did not verify.
- Fix: use `tmpdir()` and delete `readmodel-directory.ts`. If a worktree root is truly required, add one `testRoot(prefix)` helper with the reason in one comment. Remove the read-queue directory in `finally`, or stop writing its evidence.
- Validation: run the suites from `packages/loopy` as cwd and from the repo root, then confirm `.loopy/architecture-tests` gets no new entries.

**T5. Campaign constants and a campaign-named mode are wired into permanent tooling and gated tests.**
`scripts/playground/receipt-inventory.ts:6,17,55-56` (528, 525, 461, 3), `scripts/playground/profile.ts:4` (`z.literal("architecture")`), `stack-identity.ts:9`, `metrics-snapshot.ts:25`, `verify-receipts.ts:12-20`, `config-schema.ts:13,35`, and truthy `profile.name` branches in `stack-config.ts:28,37,72`, `supervisor.ts:90,109,144`, `config.ts:53`, `metrics-sql.ts:18,35`.

- The playground now has two modes for good, "default" (filesystem receipts, ports 15070+) and "architecture" (durable-object receipts, ports 15270+, a different image tag). The choice is spelled three ways: `profile.name` as `"architecture" | undefined`, `StackSelection.profile` as `"default" | "architecture"`, and the `LOOPY_PLAYGROUND_PROFILE` env var. `config-schema.ts:13` gives `receiptMode` a `.default("filesystem")` so config files written before the field still parse. That is a compatibility path for local state.
- Gated tests pin one run: `receipt-inventory.test.ts` builds 528 admissions to match the hardcoded counts, `profile.test.ts:22-53` restates every port and path constant, and `baseline-gate.test.ts` hardcodes the a/b/c cohorts.
- Consequence: the next workload change (cohort size, failure ratio) breaks `verify-receipts` and the gate together, and the name "architecture" stops meaning anything once this merges.
- Fix: this needs a decision from Hatim. Option A: durable-object receipts become the only playground mode. Delete the filesystem branch, the default profile and the `.default("filesystem")`, and fold the port offset away. Option B: keep both, but name the mode after what it does (`receipts: "filesystem" | "durable-object"`) and derive the expected counts from the cohort plan instead of literals. In both cases, drop the constant-restating parts of `profile.test.ts`.
- Validation: `bun test scripts/playground/_tests_` passes. For option A, `grep -rn "profile.name" scripts` comes back empty.

**T6. Two evidence roots, 15.7 MB of raw captures in git, and lint bent to fit them.**
`.notes/cloud/evidence/architecture/` (about 80 files, 14 MB) and `.notes/cloud/architecture/evidence/` (2 files), `biome.json:24-33`, `.notes/cloud/evidence/architecture/playground-daemon-offline-audit.py`

- Commit `7f6976a` is 101 files and 435,719 lines, nearly all JSON. The largest files are the cohort semantics captures at 76k, 68k and 41k lines. This dominates `git diff main...`, and any future `git log -p` or blame on the branch.
- `biome.json` raises `maxSize` to 16 MiB and turns off formatting for both roots. The linter still parses them on every `biome check .`.
- A Python audit script sits inside the evidence folder, outside any lint or typecheck. `scripts/daemon-playground/backup.py` predates this range.
- Fix: pick one root (`.notes/cloud/evidence/architecture/` is already the profile's `evidence` path). Commit the summaries, keep raw captures out of git with their SHA-256 recorded, and exclude `.notes/**/evidence/**` in `files.includes` instead of raising `maxSize`. Move or delete the `.py`.
- Validation: `bun run lint` time and `git count-objects -vH` before and after. Then `grep -rn "architecture/evidence" scripts packages .notes` resolves to the single root.

### Valuable cleanup, medium value

**T7. The read-model negative control tests a hand-written query, not production.**
`packages/loopy/_tests_/readmodel-workerd.test.ts:129-136`, `packages/loopy/_tests_/fixtures/readmodel-workerd.ts:55-76`

- The `/old` route builds its own `IN (?, ...)` SQL and checks that workerd rejects more than about 100 bind variables. That pins a platform limit. It was useful once to show the old bug was real, and it would pass even if the production store were deleted. The test at `:111` already proves the production scope query works at 97, 98 and 200.
- Fix: delete the test and the `/old` branch.
- Validation: the suite passes.

**T8. The receipt shape conversion is copied into tooling and tests.**
`scripts/cloud/filesystem-receipt.ts:6-23`, `packages/loopy/_tests_/cloud-sandbox.test.ts:676-683`. For the source reviewer: `apps/sandbox/src/filesystem-journal.ts:47-72`, and `{ ...record.plan, kind }` at `attempt-monitor.ts:65`, `attempt-admissions.ts:138` and `attempt-exports.ts:116`.

- The new record is `AttemptRecord { plan, session, result }`. Scripts and one test convert it back into the old flat `StoredReceipt` so existing assertions keep compiling. `cloud-sandbox.test.ts` adds a `BOUNDARY:` decoder that accepts both shapes. The old type stays alive as an in-memory currency through these adapters.
- Fix in tooling: make `scripts/cloud/*` and `cloud-sandbox.test.ts` read `record.plan.*` and `record.result` directly, then delete `filesystem-receipt.ts`'s reshaping and `decodeDiskReceipt`. Whether production keeps reading legacy files on disk is a data question. AGENTS.md says not to add compatibility paths for discarded databases, so ask whether any retained filesystem receipts matter.
- Validation: `bun run typecheck`, then `grep -rn "StoredReceipt" scripts packages/loopy/_tests_` returns nothing.

**T9. The durable receipt composition exists only in scripts.**
`scripts/playground/provider.ts:27-45`, `packages/loopy/_tests_/fixtures/architecture-docker-proof.ts:88`, compared with `apps/sandbox/src/filesystem.ts:9-24` and `apps/sandbox/src/index.ts:35`

- `apps/sandbox` ships `filesystemDependencies`, but the HTTP authority wiring (authority, `resultsFor`, backend, `DockerArtifacts`) is written by hand in the playground provider and again in the proof. The sandbox CLI entry can only start filesystem mode.
- Fix: add a `durableDependencies(config, { url, token, namespace, backend? })` next to `filesystemDependencies` and call it from the provider. Whether the CLI should expose it is a product call.
- Validation: typecheck, plus the playground provider diff shrinks.

**T10. Documentation ownership is stale.**
`AGENTS.md:5-26, 45`, `apps/cloud/README.md`, `apps/sandbox/README.md`

- AGENTS.md "Where code goes" has no `service/`, `apps/cloud`, `apps/sandbox` or `scripts/` entries. Line 26 lists only two test roots, but `scripts/playground/_tests_` is now gated. Line 45 still says `local/service.ts` owns mutations and wire views, while this range moved that work into `service/{mutations,queries,run-views,schedules,definition-catalog}.ts`, leaving `local/service.ts` as a 174-line adapter.
- The cloud README does not mention the `SANDBOX_RECEIPTS` Durable Object, the `RECEIPT_RESULTS` bucket, migration `v2-receipts`, `/internal/sandbox-receipts` or the `RECEIPTS_*` variables. The sandbox README does not mention sessions, epochs, export guards or durable mode. The architecture is documented only in `.notes`. Both the pr-review skill and AGENTS.md expect a refactor to update its own ownership docs.
- Fix: add one ownership line per new module group to AGENTS.md, fix lines 26 and 45, and add a short "receipt authority" section to each app README.
- Validation: grep the READMEs for the binding names.

### Low value or subjective

- **T11. Duplicate provider fake.** `host-policy-fixture.ts:47` `PolicyProvider` is a third copy of `Provider` in `cloud-durable-host.test.ts:45` and `cloud-scheduler.test.ts:151`. Merge them into the fixture. The `host-policy-{fixture,model,replay}.ts` helpers also sit at the `_tests_` root while every other helper from this range is in `fixtures/`.
- **T12. Duplicated BFS harness.** The enumeration loop appears in `host-policy-model.test.ts:5-38` and `fixtures/sandbox-authority-model.ts:153-197`. A shared `explore(initial, actions, step, depth)` would be about 25 lines. Also, `host-policy-model.test.ts` replays every transition, not just new states. I did not measure the cost.
- **T13. Optional dependency kept for tests.** `packages/loopy/src/executor/local.ts:20,27-31` makes `receipts` optional with a default and then throws if `receipts.descriptor.home !== options.home`. Production (`local/daemon.ts:24`) always passes it. The optional exists for about 15 test call sites, and `home` now has two sources of truth. Make `receipts` required and derive `home` from it. This touches source, so flag it to the source reviewer.
- **T14. Public contract widened.** `contract/index.ts` now uses `export *` for `sandbox-journal.ts` and `sandbox-journal-rpc.ts`, so the published `loopy/contract` entry carries about 30 cloud-and-sandbox-only symbols. `apps/cloud` imports them through the index while `apps/sandbox` deep-imports the files. The same pattern already existed for `sandbox.ts`. Pick one import style.
- **T15. Small tooling duplications.** The stop-command string is built twice with a hardcoded `LOOPY_PLAYGROUND_PROFILE=architecture` (`stack.ts:50`, `supervisor.ts:144`) even though `profile.environment` exists. `config.ts:13` exports `evidenceDirectory` as an alias of `evidence`, and 11 files use the alias. `scripts/playground/tsconfig.json` duplicates root coverage, and no script or gate references it.
- **T16. The `.loopy/loopies` project marker is now hand-created in 29 test places.** It fixes a real leak, since tests used to inherit an ancestor registry, and `registry-isolation.test.ts` proves the fix. A `markProject(dir)` helper in `fixture.ts` would make the reason obvious. This is a preference.

## Did the file splitting help?

- Helped: `scripts/playground/stack.ts` (233 lines down to about 80) splitting into `supervisor.ts`, `stack-config.ts` and `stack-identity.ts`. The identity check is isolated and tested. The `cloud-receipt-*` split into five files by concern over one harness also helped. So did the read-model split, because the assertion fixtures are shared across three backends.
- Neutral: the seven `sandbox-authority-*` test files are grouped by scenario and each reads well. `delayed` (65 lines) and `helper` (71) could fold into `lifecycle` and `publication`.
- Hurt: tiny single-function files created only so tests can import them (`readmodel-directory.ts` at 9 lines, `receipt-selection.ts` at 13, `receipt-bindings.ts` at 22). The definition-summary feature has three tests and five fixtures totaling 1,275 lines against about 370 production lines, including "legacy" size cases that pin a compatibility path (`definition-summary-size.test.ts:42`). I did not judge whether that production backfill should exist.

## What improved

- Model-based checks with oracles that do not import the implementation: `fixtures/sandbox-authority-model.ts`, `host-policy-model.ts`. Failure messages carry the shortest trace prefix.
- Real-runtime receipt tests with no module mocks. `receipt-count-probe.ts` subclasses the real Durable Object to count R2 calls.
- `scripts/playground/_tests_` is wired into `package.json` `test`, so it is proven to be in the gate.
- Registry pollution from ancestor `.loopy` directories is fixed and covered by `registry-isolation.test.ts`.
- `scripts/cloud` reads receipts through one function instead of three schema parses, though see T8 about the shape it returns.
- Playground stop refuses to signal unless PID, process group, argv and launch nonce all match, and the test drives it through a `control` parameter.

## Scope gaps

- I ran nothing that imports code: no `bun test`, `check`, lint or typecheck. Every finding is static. For T1 I re-hashed the frozen files with `python3 -I`, which only reads bytes.
- I did not verify test runtime cost (T12) or whether the Docker proof needs worktree paths (T4).
- I looked at production source only to substantiate test and tooling findings. T8, T9, T13 and T14 overlap the source reviewer's scope and are marked as such.
- I read evidence JSON for aggregate structure only (`final-check.json`, `source-freeze.json` keys and path list). I did not open the bulk captures, the `.loopy` state or any database.
- I did not inspect `apps/dashboard/_tests_` beyond the two small diffs, or `scripts/daemon-playground` beyond the config diff.

## Inspected paths

`package.json`, `biome.json`, `eslint.config.mjs`, `tsconfig.json`, `.gitignore`, `AGENTS.md`, `apps/cloud/README.md`, `apps/sandbox/README.md`, `apps/cloud/wrangler.jsonc`, `apps/cloud/src/{environment,receipts-route}.ts`, `apps/sandbox/src/{index,filesystem,filesystem-journal,receipts,attempt-dependencies,config}.ts`, `packages/loopy/src/{contract/index,executor/{local,execution,index},local/{service,registry,daemon},service/registry,core/store}.ts`, `packages/loopy/_tests_/` (every file added or modified in the range, plus `architecture.test.ts`, `cloud-durable-host.test.ts:45-70`, `cloud-sandbox.test.ts:670-690`), `scripts/playground/*` (`index`, `profile`, `config`, `config-schema`, `stack`, `stack-config`, `stack-identity`, `supervisor`, `provider`, `readiness`, `receipt-*`, `baseline`, `verify-receipts`) and its `_tests_/*`, `scripts/daemon-playground/{config,prepare}.ts` (diffs), `scripts/cloud/{filesystem-receipt,failures-resources,journey-docker,transport-failure-resources,transport-failure-scenario,dev}.ts`, `.notes/cloud/architecture/ownership.md`, `.notes/cloud/evidence/architecture/{final-check,source-freeze}.json` (structure), and the directory listings and sizes of `.notes/cloud`.
