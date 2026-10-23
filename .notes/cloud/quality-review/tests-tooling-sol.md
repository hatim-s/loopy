Independent tests and tooling review

Overall verdict: this lane gained useful separation and substantially stronger durable-boundary tests. I would keep the refactor. It also gained a historical proof embedded in the ordinary test suite, which makes routine development harder. Fix finding 1 before relying on the check gate for follow-up edits. Finding 2 is worthwhile cleanup. I found no production correctness blocker within this lane from static inspection.

Source pins and limits

- Checkout: /Users/hatim.shakir/projects/loopy/cloud-integration
- Verified branch: cloud-integration.
- Verified HEAD: 9d30ca923d168e299099758e0d95f3db3ba81cf0.
- Primary three-dot range: 6ffecdfd60e16aaa335467684d918b3cd8b44813...9d30ca923d168e299099758e0d95f3db3ba81cf0.
- Merge base equals the supplied base.
- Reverse log: 69de89c, execution authorities/host/read-model refactor; 7f6976a, workload/recovery/scaling evidence; 9d30ca9, integration/watcher evidence.
- Classification: major architecture refactor with explicitly authorized related fixes. No scope objection to that bundle.
- Read the full scoped source/config/test diff, including every added fixture, and inspected relevant production composition and callers. The scoped diff has 118 files, 9,904 added lines and 376 deleted lines. No scoped test files were deleted or renamed.
- This was a source-only review. No tests, builds, imports of application code, services, network requests, Docker commands, workload launches, database reads, or mutation probes were executed. Runtime validation obligations below belong to root.
- Existing untracked quality-review work was present at entry. I did not open paired reports or prior review reports. This report is the only file I wrote.

1. [P1, check-maintainability blocker] Remove historical source hashes from the default behavioral test

Location: packages/loopy/_tests_/workspace-read-queue.test.ts:81-85, with the manifest reader at :50-75 and the repeated assertion at :234.

Before: this test did not exist at 6ffecdf. The ordinary test command already included packages/loopy/_tests_.

After: the new .test.ts file reads .notes/cloud/evidence/architecture/source-freeze.json, asserts its fixed 467-file count and literal aggregate, and compares every listed source file against that old manifest before exercising the Worker. The manifest covers 125 app files, 278 package files, 63 script files and package.json. Static inspection confirmed that examples such as packages/loopy/src/engine/step.ts, packages/loopy/src/local/service.ts and scripts/playground/profile.ts are included and match the pinned HEAD today.

Maintenance consequence: a legitimate edit to any frozen file changes its SHA-256 and fails line 85 before the queue assertions run. Even an unrelated engine change triggers this test. Deleting or moving a listed file instead fails the file read. Updating the evidence also requires preserving or changing the hard-coded count and aggregate in the test. This couples the normal check gate to historical evidence and incentivizes rewriting evidence to make source edits pass. This is a future-development failure mechanism, not a claim that the pinned tree currently fails.

Smallest safe correction: retain the actual provider hold, control-workspace, pending-read, result, and admission assertions. Remove the historical manifest/count/aggregate requirement from this default-suite test. If source stability during the trial is useful, compare a runtime baseline taken at the start with the end of that same trial. Keep the historical freeze check in an explicitly invoked proof fixture when exact-candidate evidence is requested.

Validation obligation: root should run the focused queue test on the candidate, then in a disposable copy make a harmless unrelated edit to a currently frozen module and confirm the test still reaches and passes its behavioral assertions without modifying the historical manifest. Confirm that restoring the relevant queue behavior's negative control still fails the behavioral assertion. Then run the required repository check. Do not delete the queue test to fix this coupling.

2. [P3, valuable cleanup] Clean up successful default-suite queue fixtures

Location: packages/loopy/_tests_/workspace-read-queue.test.ts:236-238; allocation at :39-42 and persistence at :114-117.

Before: the default suite did not create these queue-proof directories.

After: each invocation creates a fresh .loopy/architecture-tests/read-queue-* directory, builds a Worker into it, and persists two workerd DO/R2 trees. The inner finally disposes runtimes and closes providers, but the outer finally only writes evidence.json. No path removes the directory, including on success. This differs from the new receipt harness, whose close removes its directory at packages/loopy/_tests_/fixtures/receipt-harness.ts:123-125.

Maintenance consequence: every routine check retains another successful proof's bundles and database/artifact state in ignored workspace storage. Evidence and disposable test state accumulate together, and developers must determine which retained directories matter before cleanup. Runtime disposal releases resources; it does not remove these explicitly persisted files.

Smallest safe correction: remove this exact test-owned directory after a successful ordinary run. If retained failure evidence is useful, keep failure retention explicit and print its path, or leave permanent retention to the manually invoked proof fixture. Preserve the provider/runtime teardown and do not remove shared playground state.

Validation obligation: root should run the focused test twice and confirm neither successful run leaves its newly allocated directory. Exercise an assertion failure and confirm provider/runtime teardown still happens and any deliberately retained diagnostic path is reported. No need for a new cleanup-only unit test.

What improved

- scripts/playground/profile.ts is a useful owner for ports, roots, image selection and child profile propagation. The old stack/config paths scattered these decisions across the cloud-shaped stack and daemon comparison. The new config-schema, stack-config, stack-identity and supervisor files separate parsing, process identity, generated launch configuration and child lifetime. These are coherent responsibilities rather than arbitrary line-count splits.
- The new stack-identity checks distinguish PID, process group, state/profile and launch nonce. The negative tests exercise the actual stop function with an injected process adapter rather than sending real signals. Keeping this dependency boundary is justified.
- Receipt authority tests use a shared real workerd/R2 harness and explicit rollback, response-loss, reconstruction, immutable-result and export-guard scenarios. The filesystem tests cover a different persistence implementation. Those repetitions are useful contract coverage.
- The read-model helpers share transition history, scope seeding and assertions across memory, native SQLite and workerd. The 97/98/200 binding-limit control is materially stronger than a source-shaped SQL assertion.
- Subprocess receipt tests exercise competing parents/children and publication around confirmed child death. Keep them. They cover durable boundaries that small mocks cannot establish.
- New production injection has actual production use. packages/loopy/src/local/daemon.ts:24-44 supplies FilesystemReceipts to LocalExecutor. scripts/playground/provider.ts selects HTTP authority or filesystemDependencies. The dependencies factory is constructed under the root lock in apps/sandbox/src/attempts.ts. I found no reason here to remove that dependency design as a test-only abstraction.
- sampleSchema now owns Sample and is reused by metrics-segments.ts, removing a hand-written schema/type pair. scripts/cloud/filesystem-receipt.ts replaces three direct disk-format decoders with one reader for the new record/result representation.
- Fixture registry markers and temporary cwd changes reduce accidental ancestor-registry selection. The retained receipt-format tests concern persisted execution records; their compatibility coverage should not be deleted to reduce lines.
- Public package subpath exports did not change in this range. The new FilesystemReceipts barrel export is consumed internally by the daemon. No new public testing package was added.

Navigability and remaining debt

The tests/tooling lane is larger, especially the proof fixtures, but most of the extra code names a real boundary or scenario. The main file-splitting benefit is in workload launch/configuration and shared read-model assertions. SummaryProbe and SummarySizeProbe repeat some legacy SQL/service construction; their assertions and instrumentation differ enough that I would not introduce a generalized probe framework just to merge two call sites.

The two architecture notes/evidence directories contain 101 tracked files totaling 15,658,219 bytes. I inspected file sizes and aggregate structure, not bulk record contents or review verdicts. Separate evidence paths and the Biome size/format override make sense for immutable generated records, but this is costly review material. That size alone is not a correctness finding or a request to discard recovery evidence. Finding 1 is the concrete place where evidence organization now obstructs ordinary development.

CONTRIBUTING.md still describes loopy/runtime, step replay and schema recreation; AGENTS.md omits the already-existing portable service layer. These documents were unchanged by this range, and the same AGENTS ownership map was present at the primary base. Treat their stale architecture guidance as preexisting debt, not a newly introduced refactor defect. The new .notes/cloud/architecture/ownership.md describes temporary lane ownership rather than a durable contributor map. I inspected that planning map only after forming the source findings and did not use its acceptance language as evidence.

Scope gaps

This report does not certify executor, host, cloud authority, sandbox or service correctness as a whole. I followed production callers only as needed to assess test seams, coverage and module ownership. I did not inspect the full broader dee31da...6ffecdf diff. No performance, browser, real Docker, crash-recovery execution, deployed-cloud or actual check-gate result is claimed. The current-source manifest observation was a static comparison of a few representative Git blobs; no mutation probe was performed.

Inspected paths

All changed paths below were read in the scoped diff. Additional context reads included AGENTS.md, CONTRIBUTING.md, README.md, apps/cloud/README.md, apps/sandbox/README.md, .notes/cloud/architecture/ownership.md, tsconfig.json, packages/loopy/package.json, scripts/build.ts, packages/loopy/_tests_/architecture.test.ts, packages/loopy/src/executor/{local,execution,index}.ts, packages/loopy/src/local/{daemon,registry,service}.ts, packages/loopy/src/service/{service,queries,definition-catalog}.ts, apps/sandbox/src/{attempts,attempt-dependencies,filesystem}.ts, scripts/playground/{metrics-request,metrics-sampler}.ts, and scripts/daemon-playground/config.ts. I also read the source of .notes/cloud/evidence/architecture/playground-daemon-offline-audit.py without running it.

```text
.gitignore
apps/dashboard/_tests_/connection-security.test.ts
apps/dashboard/_tests_/review-data-fixture.ts
biome.json
package.json
packages/loopy/_tests_/cli-fixture.ts
packages/loopy/_tests_/cloud-artifacts.test.ts
packages/loopy/_tests_/cloud-receipt-authority.test.ts
packages/loopy/_tests_/cloud-receipt-export.test.ts
packages/loopy/_tests_/cloud-receipt-http.test.ts
packages/loopy/_tests_/cloud-receipt-recovery.test.ts
packages/loopy/_tests_/cloud-receipt-results.test.ts
packages/loopy/_tests_/cloud-sandbox.test.ts
packages/loopy/_tests_/cloud-service.test.ts
packages/loopy/_tests_/dashboard-queries.test.ts
packages/loopy/_tests_/dashboard-scale-fixture.ts
packages/loopy/_tests_/definition-summaries-service.test.ts
packages/loopy/_tests_/definition-summaries-workerd.test.ts
packages/loopy/_tests_/definition-summary-size.test.ts
packages/loopy/_tests_/executor.test.ts
packages/loopy/_tests_/fixtures/architecture-docker-proof.ts
packages/loopy/_tests_/fixtures/architecture-docker-resources.ts
packages/loopy/_tests_/fixtures/architecture-docker-runtime.ts
packages/loopy/_tests_/fixtures/architecture-docker-scenarios.ts
packages/loopy/_tests_/fixtures/executor.ts
packages/loopy/_tests_/fixtures/local-receipts-child.ts
packages/loopy/_tests_/fixtures/local-receipts.ts
packages/loopy/_tests_/fixtures/readmodel-assertions.ts
packages/loopy/_tests_/fixtures/readmodel-copied-data.ts
packages/loopy/_tests_/fixtures/readmodel-directory.ts
packages/loopy/_tests_/fixtures/readmodel-history.ts
packages/loopy/_tests_/fixtures/readmodel-scopes.ts
packages/loopy/_tests_/fixtures/readmodel-workerd.ts
packages/loopy/_tests_/fixtures/receipt-count-probe.ts
packages/loopy/_tests_/fixtures/receipt-harness.ts
packages/loopy/_tests_/fixtures/receipt-recovery-probe.ts
packages/loopy/_tests_/fixtures/receipt-rollback-probe.ts
packages/loopy/_tests_/fixtures/sandbox-authority-lifecycle.ts
packages/loopy/_tests_/fixtures/sandbox-authority-model.ts
packages/loopy/_tests_/fixtures/sandbox-authority.ts
packages/loopy/_tests_/fixtures/summary-service.ts
packages/loopy/_tests_/fixtures/summary-size-body.ts
packages/loopy/_tests_/fixtures/summary-size-runtime.ts
packages/loopy/_tests_/fixtures/summary-size-workerd.ts
packages/loopy/_tests_/fixtures/summary-workerd.ts
packages/loopy/_tests_/fixtures/workspace-read-queue-provider.ts
packages/loopy/_tests_/host-admission-race.test.ts
packages/loopy/_tests_/host-denial-fence.test.ts
packages/loopy/_tests_/host-policy-fixture.ts
packages/loopy/_tests_/host-policy-model.test.ts
packages/loopy/_tests_/host-policy-model.ts
packages/loopy/_tests_/host-policy-replay.ts
packages/loopy/_tests_/host-slot-retention.test.ts
packages/loopy/_tests_/host-targeted-polls.test.ts
packages/loopy/_tests_/local-daemon.test.ts
packages/loopy/_tests_/local-receipts-recovery.test.ts
packages/loopy/_tests_/local-receipts.test.ts
packages/loopy/_tests_/readmodel-counts.test.ts
packages/loopy/_tests_/readmodel-scopes.test.ts
packages/loopy/_tests_/readmodel-workerd.test.ts
packages/loopy/_tests_/registry-isolation.test.ts
packages/loopy/_tests_/registry.test.ts
packages/loopy/_tests_/sandbox-authority-contract.test.ts
packages/loopy/_tests_/sandbox-authority-delayed.test.ts
packages/loopy/_tests_/sandbox-authority-helper.test.ts
packages/loopy/_tests_/sandbox-authority-lifecycle.test.ts
packages/loopy/_tests_/sandbox-authority-model.test.ts
packages/loopy/_tests_/sandbox-authority-publication.test.ts
packages/loopy/_tests_/sandbox-authority-shutdown.test.ts
packages/loopy/_tests_/secrets.test.ts
packages/loopy/_tests_/service.test.ts
packages/loopy/_tests_/source-artifact.test.ts
packages/loopy/_tests_/wait-host.test.ts
packages/loopy/_tests_/workspace-read-queue.test.ts
scripts/cloud/failures-resources.ts
scripts/cloud/filesystem-receipt.ts
scripts/cloud/journey-docker.ts
scripts/cloud/transport-failure-resources.ts
scripts/cloud/transport-failure-scenario.ts
scripts/daemon-playground/config.ts
scripts/daemon-playground/prepare.ts
scripts/playground/_tests_/baseline-fixture.ts
scripts/playground/_tests_/baseline-gate.test.ts
scripts/playground/_tests_/profile.test.ts
scripts/playground/_tests_/receipt-evidence.test.ts
scripts/playground/_tests_/receipt-inventory.test.ts
scripts/playground/_tests_/receipt-selection.test.ts
scripts/playground/_tests_/stack-identity.test.ts
scripts/playground/baseline.ts
scripts/playground/cohort.ts
scripts/playground/config-schema.ts
scripts/playground/config.ts
scripts/playground/index.ts
scripts/playground/metrics-daemon-sql.ts
scripts/playground/metrics-inventory.ts
scripts/playground/metrics-journal.ts
scripts/playground/metrics-matched.ts
scripts/playground/metrics-runtime.ts
scripts/playground/metrics-segments.ts
scripts/playground/metrics-snapshot.ts
scripts/playground/metrics-sql.ts
scripts/playground/metrics-statistics.ts
scripts/playground/metrics.ts
scripts/playground/prepare.ts
scripts/playground/profile.ts
scripts/playground/provider.ts
scripts/playground/readiness.ts
scripts/playground/receipt-bindings.ts
scripts/playground/receipt-evidence.ts
scripts/playground/receipt-inventory.ts
scripts/playground/receipt-selection.ts
scripts/playground/repository.ts
scripts/playground/stack-config.ts
scripts/playground/stack-identity.ts
scripts/playground/stack.ts
scripts/playground/supervisor.ts
scripts/playground/tsconfig.json
scripts/playground/verify-receipts.ts
```

Command evidence

- `pwd`, `git status --short`, `git branch --show-current`, and `git rev-parse HEAD` confirmed the checkout, preexisting untracked report directory, branch and HEAD.
- `git log --reverse --oneline 6ffecdf...9d30ca9` and the full-pin `git log --reverse --format='%h %s' 6ffecdfd60e16aaa335467684d918b3cd8b44813..9d30ca923d168e299099758e0d95f3db3ba81cf0` printed the three commits recorded above.
- `git merge-base 6ffecdfd60e16aaa335467684d918b3cd8b44813 9d30ca923d168e299099758e0d95f3db3ba81cf0` printed the primary base.
- `git diff --stat`, `git diff --name-status`, `git diff --name-only` and `git diff --numstat` for the pinned range established the inventory and counts. The 118-file scoped numstat sum is 9,904 additions and 376 deletions.
- Read `git diff 6ffecdf...9d30ca9 -- packages/loopy/_tests_` in consecutive `sed -n` slices through line 8750, plus complete script/config/dashboard diff reads. Used `cat`, `nl -ba`, `sed -n`, `rg -n` and `rg --files` for the listed files and callers.
- `git show 6ffecdf:AGENTS.md`, `git show 6ffecdf:apps/sandbox/README.md`, and `git show 6ffecdf:scripts/playground/stack.ts` supplied before evidence. The documentation-path diff printed no changes.
- A read-only Python script parsed only the source-freeze manifest's structural fields, counted paths and compared three representative `git show 9d30ca9:<path>` blobs with the stored SHA-256 values. All three matched. `git ls-tree -rl 9d30ca9 .notes/cloud/architecture .notes/cloud/evidence/architecture` supplied the aggregate file/byte counts.
- No implementation changes, test deletions, test moves or behavior changes were made by this review.
