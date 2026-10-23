---
title: Independent review of the architecture workload harness
slug: loopy-architecture-harness-review-1
kind: review
status: changes-requested
date: 2026-10-23
base: 6ffecdfd60e16aaa335467684d918b3cd8b44813
---

# Verdict

Request changes for three P2 findings before treating the harness gates and collector as acceptance evidence. The architecture profile selects a real HTTP receipt authority, preserves the four API and backend slots, and keeps the old profile paths separate. The remaining defects concern stopping the wrong profile, admitting load without a usable baseline, and reporting collector success for an incomplete inventory.

This review classifies the harness delta as a minor tooling feature supporting the durable authority feature. The broader architecture was expressly requested. No additional PR split or approval is required by this report.

# Scope and source pin

Reviewed branch `cloud-integration`, HEAD and base `6ffecdfd60e16aaa335467684d918b3cd8b44813`, plus the uncommitted source below. The base commit alone does not identify the reviewed implementation. Read AGENTS.md, unslop, pr-review, TypeScript guidance, proposal.md, fable-review-1.md, workload-profile.md and workload-profile-checks.json. Inspected the changed playground and daemon harness paths and their sandbox/Worker composition boundaries. The receipt, host and read-model implementations outside those boundaries are separate review lanes.

All 30 source hashes in workload-profile-checks.json matched current files. Its recorded delta is 917 added lines and 254 deleted lines. Root subsequently added the 149-line verify-receipts.ts, which this review includes. The combined harness delta is 1,066 added lines and 254 deleted lines across 31 changed or new files. The root collector is absent from the earlier lane manifest and needs its own updated check receipt.

The 47 playground fixture files are unchanged from the base. Their sorted relative-path, NUL and raw-byte SHA-256 is `a543c987ac688368fe998d5d23e2ae6f219a1717974e3df705c2b548486bb404`, matching the lane audit. No fixture, production source or existing test was edited here. No test was deleted or moved.

# Findings

## P2. A stale architecture manifest can authorize stopping the legacy supervisor

Location: `scripts/playground/stack.ts:32-39` and `:58-76`, with manifest publication in `scripts/playground/supervisor.ts:123-134`.

Both profiles launch exactly the same supervisor command. The selected profile exists only in the environment. stop() checks that the recorded PID currently has a command containing this worktree's index.ts followed by serve, then signals the entire process group. It does not compare a process creation identity, selected state/profile or a per-launch identity. The stored argv and creation time do not participate in the check.

A killed architecture supervisor can leave its manifest behind. If its PID is later reused by the legacy supervisor in this same checkout, the architecture stop command passes the check and stops the legacy process group. This defeats the separation intended to protect the previous workload. The old command-only check predates this delta; introducing a second profile with an identical command makes cross-profile confusion possible.

Causal probe: invoked actual stop() against a synthetic architecture manifest. Replaced only Bun.spawn's ps observation and process.kill with inert functions. A default-profile-compatible command produced an intercepted `SIGTERM` for group `-424242`. No process was launched or signalled. Both profiles genuinely have that command, so the guard cannot distinguish them.

Smallest correction: give each supervisor launch an explicit identity in its argv, including the selected state/profile and a fresh launch nonce. Persist and verify that identity before group signalling. A positive integer PID and matching process-group ownership should also be required. Fail closed on an old or unverifiable manifest.

Missing assertion: a stale architecture manifest pointing at a legacy supervisor, and a stale manifest pointing at a later same-profile launch, must both produce zero signals. A matching owned launch must still stop successfully.

## P2. The baseline gate accepts data that contains no baseline measurement

Location: `scripts/playground/baseline.ts:12-14`, called by `scripts/playground/prepare.ts:89-90` before load-enabled.json is written at `:107-111`.

The gate checks the selected directory and batch, but samples is an array of unknown values. A receipt with `samples: [null]` passes. It does not require the baseline phase, measurement shape or a successful observation. The caller treats this parse as sufficient to enable all primary cohorts.

Causal probe: used the real createMeasure() to produce a transport-failure sample with null status and zero bytes. With synthetic same-batch source and preflight receipts, actual arm() wrote load-enabled.json and printed `Load gate opened for the current batch`. A separate call accepted `[null]`. No API was contacted. Failed observations remain useful diagnostics, but this gate does not establish that any baseline measurement is usable for the intended comparison.

Smallest correction: validate the saved baseline measurement schema and phase rather than unknown elements. Reuse the existing sample shape in metrics-segments.ts. Require successful measurement coverage for the endpoints root intends to compare, while retaining failures in the raw capture. Keep the current batch and canonical-directory checks.

Missing assertion: actual arm() must leave the gate absent for null/malformed samples, a non-baseline capture and an all-failed capture. A real, usable same-batch baseline with the three passing preflights must enable it.

## P2. The collector trusts summary counts instead of validating its workload inventory

Location: `scripts/playground/verify-receipts.ts:21-37` and `:130-138`.

The collector requires literal summary fields count=528, unique=528 and primaryJournal=525. Its runs array has no length constraint and its derived runIds set is never checked against 528. It does not read the primary admission journals or independently compare their identities and expected statuses. Therefore these literals do not establish the stated workload prerequisites.

Causal probe: ran the actual top-level collector with one synthetic terminal run and one completed backend identity. The inventory summary claimed 528/528/525, but there was one run and zero primary journal files. With an injected read-only authority returning one valid blob result, the collector wrote `status: "passed"`, `runCount: 1`, `verifiedReceipts: 1`. The real receiptEvidence() resolved and hashed the result. There were zero HTTP calls or services. This demonstrates contradictory passed evidence rather than a missing test alone.

Smallest correction: require exactly 528 run rows and 528 unique IDs, then load the selected primary admission journals and derive the 525 distinct admitted IDs, current batch, inventory membership and expected statuses. Derive mismatch results instead of accepting those summary fields as proof. Keep stopped-authority enumeration as a separate check for unknown records.

Missing assertion: reject the one-row/literal-528 case before authority reads and before any passed output. Also reject duplicate rows, a missing primary journal, foreign batch, null admission ID and an expected-status mismatch. A complete synthetic 528/525 dataset must still pass without a session nonce in its output.

# Confirmed behavior and limits

- Strict profile parsing rejects every explicit value except architecture. Its cloud state, daemon state, frozen repository, evidence, runtime queue, API semaphore and pressure lock paths are distinct from the legacy paths. Ports are 15270 through 15273 and daemon 15370. start() and serve() check the selected ports; the daemon checks its own port on start. No actual ports were probed in this review.
- cleanEnvironment() explicitly carries LOOPY_PLAYGROUND_PROFILE into the detached supervisor and its Worker, sandbox and dashboard children. The daemon environment carries it into CLI and daemon children. A probe of actual cleanEnvironment() and writeStackConfig() confirmed the selected value, root, namespace, port and concurrency in isolated generated files. This is composition evidence, not observation of live child environments.
- The strict architecture config requires durable-object and four distinct user, alternate-user, sandbox and receipt credentials. The generated Worker private vars include the receipt credential separately. No real credentials were read. No injected receipt credential is part of bundle launch environment construction in this harness.
- supervisor.ts awaits bounded Worker health before launching the architecture sandbox. provider.ts passes a dependency factory to startSandbox(), not an unused binding. Attempts.open() holds the bridge OS lock before calling that factory, which rejects populated receipts or exports and supplies HttpSandboxAuthority, resultsFor(), the bounded Docker backend and DockerArtifacts. The authority opens its session only after this point. No fallback branch is reachable from a valid architecture config.
- An actual Attempts.open() probe observed the owned service.lock inside its injected factory, rejected a populated synthetic receipt root and released the lock while preserving that file. It stopped before authority construction. Existing focused tests cover populated exports too. No server or Docker backend was started.
- Nine concurrent actual PlaygroundClient.request() calls with injected responses reached a maximum of four fetches. Nine RuntimeLimit operations reached a maximum of four active operations. The pressure guard accepted an injected safe four-worker sample, then rejected ABORT before another inspection. Backend/pressure policy source remains unchanged apart from consuming selected paths.
- Actual execute() with an injected lost POST acknowledgement persisted its null-ID intent. Calling execute() again refused ambiguous admission and made no second POST. Total injected fetch calls for those two admissions was one. The exclusive cohort locks and successful-summary idempotence remain in source; no real cohort was run.
- Cloud SQL diagnostics canonicalize a regular file under the selected diagnostics directory and match the root-supplied architecture profile, closed-source assertion, path, batch and SHA-256 before opening SQLite. They retain the API identity/status comparison and after-close hash check. A declaration of sourceClosed is root's observation, not a closure proof from the script. Daemon analysis consumes the isolated stopped backup produced by its owned runner. This review opened no database.
- The new collector selects architecture and durable-object, rejects duplicate/foreign/unresolved queue identities, uses the real receiptEvidence() authority read and immutable-result get/hash path, checks terminal result kind, strips session nonce, caps sequential work to ten pairs per second, checks empty filesystem receipt/export directories and verifies the queue hash again. The synthetic collector probe confirmed nonce omission and one authority/result read pair. These checks do not enumerate unknown DO records or unreferenced R2 blobs.
- Running the collector after performance sampling is a root sequencing obligation. The source contains no performance-complete guard; the probe passed with no performance capture present. Its evidence text states the intended order, not an enforced prerequisite.

# Verification record

Ran only focused offline verification. All synthetic writes were beneath fresh worktree-local .loopy/architecture-tests paths. The report is the only repository artifact written by this review.

1. `TMPDIR="$PWD/.loopy/architecture-tests/harness-review-20261023-01/tmp" bun --no-env-file test scripts/playground/_tests_` printed `9 pass`, `0 fail`, `61 expect() calls`, three files. Test temp directories were removed by their existing cleanup.
2. `bun --no-env-file -` with isolated config, same-batch synthetic gate files and injected process observations printed actual-arm gate opened, null sample accepted, selected generated config matched, and intercepted wrong-profile group signal. Root `harness-review-offline-Nv34VM`.
3. `bun --no-env-file -` using actual Attempts.open(), guard() and RuntimeLimit printed postLockFactoryObserved=true, populatedReceiptsRejected=true, lockReleased=true, receiptsPreserved=true, abortPreventedInspection=true and runtimeLimitMaximum=4. Root `harness-review-lock-Up5xsU`.
4. `bun --no-env-file -` using actual client and execute() with injected fetch printed globalApiMaximum=4, ambiguousPostCallsAcrossTwoExecuteCalls=1 and intentRetained=true. Root `harness-review-admission-Yjz4Sd`. An earlier version of this review probe stopped with `Export named 'profile' not found` because its mock config omitted an export. Adding that mock export fixed the probe. Production source was not changed.
5. `bun --no-env-file -` using actual verify-receipts.ts and receiptEvidence() with an injected read-only authority printed status=passed, actualRunCount=1, claimedInventoryCount=528, primaryJournalFilesWritten=0, authorityReads=1, resultReads=1 and sessionNonceOmitted=true. Root `harness-review-collector-wikNpW`.
6. `git diff --check -- scripts/playground scripts/daemon-playground` exited zero with no output. Python source/fixture hashing found no original manifest hash mismatches and no fixture diff from 6ffecdf.

The inline probes are bounded causal demonstrations with synthetic inputs, not runtime parity tests. No API, Docker, shared service, real credential, live database, main checkout, commit or child agent was used. No broad check was run.

# Root checks still required

These are acceptance gates this review has not established. Root may satisfy them with existing pinned receipts where available.

1. Correct the three findings, add the missing causal assertions, refresh source hashes and rerun the affected offline checks. Include the collector in the check manifest. Converge the other implementation lanes before the root-owned full bun run check and final integration gates.
2. At actual launch, recheck all reserved ports, verify the exact owned processes and selected generated files, and record new state/evidence paths. Keep legacy state and protected services untouched. The public start command returns status=starting before readiness, so wait for owned Worker, sandbox and dashboard readiness before prepare or status-dependent work.
3. Capture a usable first baseline and inspect failures/endpoint coverage before arming. Complete three preflights plus exactly 525 primary runs with 461 primary successes, 64 controlled failures and 125 approvals. The combined API inventory should have 528 unique terminal IDs. Complete 45 daemon runs with 39 successes, six controlled failures and nine approvals. Preserve admission intents, approval history, pinned fixture revisions and retained output checks.
4. Save raw continuous, matched and postload performance evidence before the authority collector. The existing metrics commands accept the architecture profile. Record sampler stop/completion times so collector traffic is excluded from performance windows. Do not interpret metrics-segments.ts's inherited authorized-prelaunch-refresh labels as proof that a failure or restart was authorized; tie such labels to actual root events.
5. After those captures, while the selected Worker is still available, run `LOOPY_PLAYGROUND_PROFILE=architecture bun --no-env-file scripts/playground/verify-receipts.ts`. First satisfy finding 3. Then stop the owned authority before taking its approved SQL copy and enumerate all authority records to compare the complete identity set with known backend attempts, not just their count. The collector deliberately cannot discover unknown records. Check terminal pointers and the resolved result references together; absence of local receipt files alone proves no DO/R2 use.
6. Supply or cite real local workerd/DO/R2 and Docker acceptance for session fencing, same-session lost-admit acknowledgement with a temporarily unavailable resolving read, restart recovery without replay, immutable terminal publication, transport ambiguity, worker loss, timeout, retained export guards and shutdown. Record authority/result call counts and write amplification. The harness composition and synthetic probes do not establish these behaviors.
7. Use only verified closed copies for SQL analysis. For cloud diagnostics, root must create the selected closed-copy allowlist with the actual canonical path, current batch and hash. For daemon analysis, verify the owned runner stopped and that its retained backup is the regular isolated copy. Establish copied-schema-15 query/open equivalence, actual workerd scope-page boundary behavior and summary DDL/backfill acceptance through their respective lanes.
8. Finish browser acceptance and main integration under root's existing authorization after the full checks and workload evidence pass. Those actions remain outside this review.

The documented profile commands resolve through the selected entry points, including daemon prepare/run/analyze and the new collector. This review did not execute them against a live stack. WORK.md records root's initial local prerequisites while workload-profile.md correctly records that its lane launched nothing; those statements are consistent because they describe different owners. The earlier workload-profile-checks.json does not cover the later collector addition.

# Hash manifest

The final harness snapshot has 59 files and aggregate SHA-256 `fd602bbcc46ec361875e38f50c545b879687b468bd62858e041ff23ab3a720bf`. The aggregate hashes the sorted UTF-8 records `relativePath + NUL + fileSha256 + newline`. It includes unchanged harness dependencies and backup.py. Any subsequent harness edit requires a refreshed review pin.

```text
1deb3568dda2db26778152e24a2c900dbaa1a625a5c78404633275f65a13601c  scripts/daemon-playground/analyze.ts
f298a32cec9cc4e8af40e00288921b079ad3d9ba11b55350003c4abc041ed2fc  scripts/daemon-playground/backup.py
9e09b8d42f603816cf100585834e7b47b08429e188a4b440feb9deb7c4ffbcf0  scripts/daemon-playground/backup.ts
afc9721a54274bf73b0a7f28f926097da4e1dac793af351af48764c90a3b8dd1  scripts/daemon-playground/capture.ts
7e7d27df43c284c7de0b37e534c9665cde41702859a26b21efc413b30f0a524f  scripts/daemon-playground/closed-executions.ts
61b5aa989103edecf725370f55a97d7f74188e3583ab84ab58acd0a4c8768dcc  scripts/daemon-playground/config.ts
65e378aaab31c11b913a94db9f1ed3b3b1cd64e11f35244a0ec83f90699f4d29  scripts/daemon-playground/daemon.ts
af6111a17d3492b382909a2f0e1e0ac72b1b51ca748bc74572d868c131c046d3  scripts/daemon-playground/outcomes.ts
2ed621ede78f00a479271bb4b046b28112eb08a4bd635b654333dfbc2173a9c0  scripts/daemon-playground/prepare.ts
9a4526d40346d61eb64d80107a13251c99b05ccb28eded760ebe1171e17d80b2  scripts/daemon-playground/report-schema.ts
0be0fdb487ce2bcf21b1c94dd54098d5c607fb63f3caf78f72215f6a51217aeb  scripts/daemon-playground/run.ts
a98d5d0e3eec585c578ca4c0fb93ae6a62c505b757f5b8505281c1cf577c633c  scripts/daemon-playground/semantics.ts
43a13856c852ead26dc4c8fd5073c971d5dfb6b9e6c800f6785aafc13ce77c16  scripts/daemon-playground/source.ts
36eb61ea264e0f9215ebfd8e0c3862191fc54633d859ed3efb6bd99550a13dbc  scripts/daemon-playground/waits.ts
cf906451a960b65e8ebc3baf9e9059227f8c17d82dc1fe53d6062a6ad4c2f1ab  scripts/playground/_tests_/profile.test.ts
09ff2af225fe2af3e3641d201f7a95b6c2101b4b06289607d55580867c3dda3f  scripts/playground/_tests_/receipt-evidence.test.ts
43f20071f2cc7e892a6b0b22d160a482758a35416aacc22340d6e2974995479f  scripts/playground/_tests_/receipt-selection.test.ts
5d907733c9c2c8c83d8fb1718482fc7237e6a4aa2ad524eefcd46549bf82f5ee  scripts/playground/approval.ts
6ff4d71ff37f5942579a56ce3dded1399f62253907897799f938c51870161c42  scripts/playground/artifacts.ts
0c5fb40f8b65c9166ebed3d86b8297e4f92c81cd97cbb0c94a12d5c3641b9366  scripts/playground/baseline.ts
7806673911064109207e2a721494a4367cb522f62f1303ee8cd931046f924aa0  scripts/playground/client.ts
f6ef224480da583e6611e5cf0a133924adc7b210536b1d3126920c1c8902806c  scripts/playground/cohort.ts
b8cb38a4bcb85c65a4ef417a190b53b835a9395cab4f469663e4f484c9ffaa83  scripts/playground/config-schema.ts
06da67f2830cb1d2f22385078c10428365dee9052f23d31f0470c3e180b007df  scripts/playground/config.ts
1213d36290bf1cf94a7587cc54d6320bda41cba2d6a6ccc29943af8b278c42a9  scripts/playground/guard.ts
3b8e0837b6963b58c1edce4dc47820c2a378a742843d2aaa110e8f84277fe6f0  scripts/playground/index.ts
d5b0dfccb453a5dc48c51cb8117937447969e9a647f8282f05830346403aa992  scripts/playground/journal.ts
090809c2390d5768571400d1d3ebee8ce537eb2225e7516f5a3692a32bfeed5b  scripts/playground/metrics-daemon-sql.ts
06a78fa1fe82c28dcc9966d1cc2537a712c1b2e8f1421b751302b826f48df605  scripts/playground/metrics-inventory.ts
ea124560b92916c934cfe49723db87dd0568712ebae673736fedac6ad81b293a  scripts/playground/metrics-journal.ts
4f055fecf3d07fc0f0d8fcc3ec5a72f25ad58df3be5d993a47c3a8bacbf9f961  scripts/playground/metrics-lifecycle.ts
b4f6af4bb9ff51fd8b3e58eab70884765d92804fc39450451c20a0b5589400af  scripts/playground/metrics-matched.ts
221bbc2300d252bd945ff0e737a081f830a3f5d13b0b514d6dd747a3aa82c9e1  scripts/playground/metrics-request.ts
d07d6fc96c42ed743fed02a5dcd4e9f8fbad1c843ce1f3836d76727f2f2faa36  scripts/playground/metrics-resources.ts
6c8990af87fd57fb4070594c52a7007c57787e183828d3ef1175c3a62d762380  scripts/playground/metrics-runtime.ts
6b2a78581076a7d7b41e68d846ff50523bbca9800387f1ced83c363aeccffecc  scripts/playground/metrics-sampler.ts
64220dc1339e10b59465dd5d972a5193ef46c71dd00e70b2ab8e4f4172e04703  scripts/playground/metrics-segments.ts
89b66d4c18f08198dab8c292ad658db302839e80c566d29becf3bc12ebd23a2b  scripts/playground/metrics-snapshot.ts
433d4c98f37d4c2e31d3501037bf7c397c135825529bab9161c47558b4226cbe  scripts/playground/metrics-sql-driver.ts
412926675741224b11b9c3c460ee865b0ef6ee411f9902430505dbed7f5b49e3  scripts/playground/metrics-sql-queries.ts
15ba3c8c59204c057eabebce4b61bbd13327c4d58e96f038f1250d8f454fb295  scripts/playground/metrics-sql.ts
b532042350c496762c8c1d804970220184759a0129a0bcf4844c6f285b4a8c6f  scripts/playground/metrics-statistics.ts
a28e0ce43de7c5c74851897b485e8aeead5210c91f3f2770625b3c700919cc36  scripts/playground/metrics.ts
e6de226126461b46d11b9708961f737e9c1ed2e07cc757cb6b0d29ec54e93aee  scripts/playground/outcomes.ts
03c926dda877898a5f38251971891dc9c68b95df41168979b4ba37bbd228ee3f  scripts/playground/prepare.ts
9fdf65bd8227d216023e757a796f34eff920fb2878178840a7c9283dfa62f3e3  scripts/playground/profile.ts
a9c46001be9c1f18a782cef748a0f8e55282d7ac76d24ed51bf0c94c0f4146da  scripts/playground/provider.ts
638f9370f293a612cc2313d4cb20a1d5b3e6704dd77ba1c534b4e2d341349d93  scripts/playground/readiness.ts
d42b06d1e5070ff6695606c3ba3eae787a0408d11d6829aef880098b5887966b  scripts/playground/receipt-bindings.ts
268c887347100e6e5a96573f0046306dde778d474eb69737917b131738a35fc5  scripts/playground/receipt-evidence.ts
07c5befac3554d800c14e8a5d4c46ebce4c1cad0b1785120808170f63b71635e  scripts/playground/receipt-selection.ts
4cad5ac6dead0285ed47ab76293df81de2d70e4b1a8e8ddac64788d00c875ea4  scripts/playground/repository.ts
7a11e6c61f9185ac8bf8ca864a3b6548bcedf9dd471a7ce23538c513387ef5ec  scripts/playground/run.ts
d98d94bc915ba77fc8b16cf83f23417f0d010022b49782ce12afff7d51497d5f  scripts/playground/runtime-limit.ts
4f550d58d62ac1855de604e0a5e29864e1b97876cc0f419839417761735956c2  scripts/playground/stack-config.ts
90c37bc288af8cfe8f550a586205ff2c4cf6c087a192e5f272ce719052671baa  scripts/playground/stack.ts
6068c198047a859cc08baa39883e93265659d0088fde449bb13788fc2f07614b  scripts/playground/supervisor.ts
39bfccb7b3f9ca624ecb19dfd5651c5522dd6971d70a1df3fb3ea26701b82ae0  scripts/playground/tsconfig.json
11ffe49479ae65d77172ce695a9767ede64730653a1e15c30adddb49116cfe29  scripts/playground/verify-receipts.ts
```

Inspected boundary and input hashes at report time. Other implementation lanes may still change these files.

```text
da64eb371e74ebb6bac07ccdbca76d4e845390e601ec81874adaace4afd05658  AGENTS.md
bf1a393476b6d142a1bef26df6e0258e6735fb1a8351597883d9808dba4cdf70  .notes/cloud/architecture/proposal.md
19e286fa9f296457b0593758bac92a8893c444eb26bdee0515eece1c50c0bd99  .notes/cloud/architecture/fable-review-1.md
a17190c0d71ee1e9dcefaf0c47a5491996561d375554c2170faaf60fbf0cafc7  .notes/cloud/architecture/workload-profile.md
5fa554380137afb4e3932302dbf57cf498ca420d24d125335bee6d9e0019e494  .notes/cloud/architecture/workload-profile-checks.json
a8bffa4bc58d35daf48e0b6e38bf2dbb975e54ccf3421a8d024b3d32edadeee1  apps/sandbox/src/attempts.ts
64d6a3798d5ed5a68084e03e23c58bbbd4a5b7236f507ea0854b5595b37ef8f3  apps/sandbox/src/server.ts
086dc710a6520101b4da42e824c2fc0777bbafaefb9227ae66c37fbd6ac9e3f5  apps/sandbox/src/attempt-dependencies.ts
6755f03bed8ec66b41d6bb6933f3a136f6b01494c09abda577c7f52e758cc184  apps/sandbox/src/http-authority.ts
56e6737f4c79620d1f137258e3901622ee98c771f258c597e848922e33fe7ab9  apps/sandbox/src/config.ts
99b78e61d686aad65847cc59e2fc8776f5d9c83f099b40575292d57a7138d393  apps/sandbox/src/receipts.ts
7152d2b103391c4bfef3f5c6a7640509c3534a75626fb1cced8386c24ecae2c5  apps/cloud/src/worker.ts
a7a9dfa5dc19a6f1cfe6ddb904bcee5e9205084331d09e5c7e38aecbfb94b78b  apps/cloud/src/receipts-route.ts
e7451f857f97bc60eeb7a571bd9e6e4d41e9d09014a5b95248820827a666ea4e  apps/cloud/src/environment.ts
0e190391ca0d657ff76cdebdcdc8d8348449f85b975c7c778f7d761bfc4a3990  apps/cloud/wrangler.jsonc
```
