---
title: Independent architecture acceptance evidence review
status: review complete, local correctness evidence accepted with an open measurement item
date: 2026-10-23
branch: cloud-integration
base: 6ffecdfd60e16aaa335467684d918b3cd8b44813
head: 6ffecdfd60e16aaa335467684d918b3cd8b44813
head-tree: c88beff6f5e91c8a4618f77343c959afcfc90cf2
---

# Verdict

Accept the local correctness and recovery evidence for the pinned candidate. No new material source defect or contradictory workload outcome was found. Root sent `FINAL_EVIDENCE_READY`, and I verified the completed receipts and final documents in this same evidence-review turn. Closed-copy reconciliation, scoped census, daemon supplements, the controlled queue proof and the final repository check are complete at the pins below. This is not certification that every proposed measurement was completed: live workload R2-read counts and write amplification remain unmeasured. That limits cost/scaling claims; it is not an observed correctness defect in the reviewed implementation.

Root still owns the authorized commit and main integration. This review provides no remote-cloud acceptance. The open measurement item below must remain explicit in closeout, without labelling the entire proposal's measurement list complete.

This is the final evidence review of the accepted architecture and its implementation-review corrections, not a new independent source-review round. The combined scope was explicitly authorized. Its main intent is a major execution-authority feature, with the accepted host/read-model refactors, bounded query correction and supporting tooling. The earlier proposal's unsolicited PR split is not an outstanding gate.

Only this file is owned and written by this reviewer. No tests, builds, application APIs, database connections, services, Docker operations, credentials, children, commits or main integration are used here. Read-only Python checks parse retained JSON, compare sets and hash exact source and artifact files. Existing old databases are not opened. No personal or ignored private root is scanned.

# Candidate identity

The checkout is `/Users/hatim.shakir/projects/loopy/cloud-integration`. Base and HEAD both equal the full commit above, so `git log --oneline --reverse 6ffecdf...HEAD` is empty. The candidate is the uncommitted working tree, not HEAD alone.

The workload manifest `.notes/cloud/evidence/architecture/source-freeze.json` contains 467 source/harness files. I independently rehashed every listed file and found zero mismatches. Its file SHA-256 is `34369d678d2d9baf06841c5309e066c2e0b6aacf0d934d03c922d98bf73d682c`; its recorded aggregate is `93e0bcd0fccac0dbf8deff30aa0eb9e4b18ec15cac090c2ec6d8cb00ae8edc52`. I verified the individual hashes and exact manifest bytes, without assuming the aggregate serialization. The selected image is `sha256:ffc247b1e3a93dc0eafb8f387ed52d5b8fc7445e929a701f2117f6a0cc175722`, as retained by the launch/proof records. No live image inspection was performed here.

The 467-file freeze does not include `biome.json`, final documents or the newly added read-queue test and fixture. Their final pins and root check must supplement the workload pin. They must not be described as part of the source used for the measured workload.

# Reconciliation with the accepted design

Read AGENTS.md, unslop, pr-review, worktree and TypeScript guidance, proposal.md, Fable round 1, the local and host reviews, data rounds 1 and 2, sandbox round 2, harness round 2, and the implementation/evidence reports relevant to their corrections.

- Fable's lost-admission correction remains explicit. Same-session reconciliation retains a start obligation and can issue one first start; a successor recovers an older admission without replay. SQL session fencing does not fence arbitrary delayed Docker commands. The single-bridge lock and exact resource identity assumptions remain necessary.
- The export correction checks the current caller session, retains the exact helper guard until confirmed absence, and lets a successor clear an older guard after cleanup. The real local proof covers retained guard, reconstruction and later release.
- Trigger-maintained totals and shared schema 16 were cut. Counts come from one authoritative grouped read. Shared schema 15 and the existing native 13/14 opening behavior are unchanged. Copied-data equivalence is not a new schema migration or a general native/cloud interchange guarantee.
- The data round-2 correction replaces the oversized inline summary row with a separate generation-matched projection. The actual-workerd size/publication/backfill review supersedes the four changed round-1 pins. All 12 source/test hashes embedded in data-review-2.md match current bytes. The four expected mismatches against data-review-1.md are exactly the four files it says changed.
- The harness round-2 corrections cover exact supervisor identity before signalling, usable baseline coverage before arm, and admission-derived inventory before authority construction. All 17 changed source/test pins in that review match current bytes. Package formatting/check policy is assessed separately below.
- The sandbox round-2 correction starts admission shutdown before awaiting HTTP drain, while retaining the lock through monitors, artifact cleanup and dependency close. Its four embedded source/test pins match. The 18 host pins and two local composition/export pins embedded in their earlier reviews also match.

These comparisons preserve the earlier reviewers' scope. Their executed tests remain prior evidence, not tests independently rerun by this review. Model counts, mutation evidence and directed adapter tests are different forms of evidence and must not be summed into a claim of exhaustive production verification.

# Auditable workload accounting

The retained driver, cohort, lifecycle, API-inventory, daemon and collector JSON agree on these distinct workflow runs.

| Workload | Distinct run IDs | Succeeded | Controlled failures | Approval holds |
| --- | ---: | ---: | ---: | ---: |
| Primary cloud A | 200 | 172 | 28 | 25 |
| Primary cloud B | 200 | 172 | 28 | 25 |
| Primary cloud C | 125 | 117 | 8 | 75 |
| Separate cloud preflights | 3 | 3 | 0 | 1 |
| Native daemon | 45 | 39 | 6 | 9 |
| Total | 573 | 503 | 70 | 135 |

The primary cloud total is 525, with 461 successes, 64 controlled failures and 125 holds. The cloud API total is 528, with 464 successes and 64 failures. The preflight hold is separate from the required 125 primary holds. Daemon preparation saved five definitions and admitted zero runs; its later 45 runs are disjoint from all cloud IDs. The daemon restart uses one of those 45 IDs and adds no run. All 573 IDs are distinct across these workload groups.

The seven bounded Docker/DO scenarios are separate fault acceptance, with five attempt identities across four synthetic run IDs and four actual sequential workers. They are not seven more workflow runs and are excluded from the 573. The earlier proxy failure reached no admission or worker; it remains failed evidence. Unit/model runs, old historical cohorts and the separate controlled queue proof also stay outside this workload denominator.

I compared all three retained primary drivers to the driver copies in their semantic receipts. Every primary admission has a unique run ID and matching expected/terminal status. The API inventory's complete 528-ID/status set equals the combined primary and preflight set. All 125 primary approvals resolve at or after their recorded due times. Observed holds reach 48,997 ms, so a hard 45-second hold bound is not established.

I read and rehashed all 461 successful primary export files at their exact journaled destinations. Byte length, SHA-256, parsed JSON and the complete retained expected object match. All 64 failed primary records have no successful export record. The 15 retained graph response bodies match their stored byte lengths, hashes, graph names and expected revisions. There were 16 graph GETs because one locally rejected response required the explicitly authorized replacement. That extra read is not an extra run or admission.

The native receipt records 45 matched runs, no failure, completion at `2026-10-23T16:02:43.466Z`, and daemon stopped. Its retained detailed records independently sum to 457 latest executions, 466 execution attempts and 400 logs. The audit records 72 scoped executions and 178 physical finished effect receipts. I rehashed all 178 exact receipt files and checked their embedded run/attempt identities against the audit joins. The retained audit script hash matches its receipt. The 272 checked workspace files are supplied semantic-audit evidence; I did not repeat that file-content validator.

The completed primary scoped census contains 4,695 distinct persisted node keys and 600 scoped keys. Group A has 1,916/200 nodes/scoped keys, B has 1,862/400 and C has 917/0. Every retained key belongs to its admitted run and pinned graph. Selected executable-node records plus retry history produce exactly the full 1,552 primary collector identities, with no missing or extra identity. All 25 retained retry histories have attempts one and two, with the failed first attempt stored as historical retrying. The retained keys plus those additional retry attempts derive 4,720 primary node attempts. The census records 1,527 executable nodes, 150 maps and 300 children, 75 parallels and 175 children, 50 sleeps and 125 completed approval waits.

I independently counted all 600 retained scope membership rows and 2,713 log records, including 41 expected stderr records. Every retained log names its admitted run and a persisted execution key. Run sequences and per-attempt indices are contiguous without duplicate positions. The per-group totals are A 999 logs, B 1,131 and C 583. The 125 sanitized persisted hooks are present. Sleep, map, parallel, failure-marker, complete log-data and graph-output semantics are supplied by the completed independent cohort validator and its per-run records, not a new database execution by this reviewer.

# Receipt and storage evidence

The online collector contains 1,560 unique attempt IDs and 1,560 unique ordered execution-key/attempt identities. All refer to the 528 cloud runs. Of these, 1,552 belong to primary runs and eight to preflights. The primary identity set equals the 1,552 completed starts retained in the primary runtime receipt. Result kinds are 1,519 succeeded and 41 failed. Failed attempts include expected retry history, so neither 1,560 nor 41 is a workflow-run count.

Every collector record reports durable-object authority, resolved immutable bytes and the terminal reference hash/size. Filesystem authority count is zero. The production collector source hashes resolved result bytes before accepting the reference. This review verifies the retained records and their identities, not a fresh online result read. Online collection alone cannot enumerate extra authority records or unreferenced R2 blobs.

I independently compared every one of the 1,560 closed-snapshot authority records to the collector's identity, request hash, session epoch, terminal kind and exact result reference. All match. The snapshot's complete 528-ID/status set matches the API inventory. Its raw queue hash matches the collector's queue pin. The snapshot records zero started receipts, zero active exports and 464 inactive guards. Twenty-five historical failed attempts have verified second-attempt successors, including four final failures, so historical retrying node rows must not be misreported as unfinished authority work.

The closure receipt retains eight original/raw files totaling 30,391,856 bytes. Source-before, after-copy, final and both raw inventories are exactly equal. It records no original processes or source handles, free owned ports, unchanged protected listeners and safe treatment of one reused foreign PID. The exact reconciliation and approved-copy manifest hashes match the files. The analysis manifest pins the same current-batch Workspace path/hash as the snapshot. I did not open either SQLite database. Sidecar-free standalone files are a snapshot-stage observation; later SQL diagnostics record an existing SHM file and leave it unchanged.

The bounded Docker proof's `rawEvidenceSha256` resolves to `evidence-summary.json`, SHA-256 `7ea26dd268b072c7b3e39e08ec17644aee232f8e543b6e12745ff9cec97a786f`. It does not name `report.json`; an initial reviewer check against that assumed filename mismatched, then the exact summary resolved the field. The raw report records four sequential starts, no source drift and no cleanup errors. I independently rehashed each of its five exact retained R2 blob files and matched every terminal hash and size. The independent cleanup receipt reports absence of exact owned resources. No Docker command was run here.

Mutable run state, sessions, admission and export exclusion belong to transactional SQL. R2 holds immutable results and compiled artifacts. It does not replace leases, mutable execution state or writable worker volumes. Results can remain unreferenced after SQL publication failure; absence of unreferenced R2 objects is not an acceptance claim. Switching populated filesystem authority to durable authority still requires a stopped verified import, which is deferred. There is no automatic migration, fallback or dual write.

# Performance and proof boundaries

I verified all seven raw capture hashes in `performance-repeat-api-measurement-done.json`. The six timing captures contain 140, 178, 1,282, 36, 178 and 36 actual samples. Every retained timing sample is HTTP 200 without a recorded failure. The seventh file is the 528-ID inventory. All API capture/inventory ends precede the collector's `15:54:45.224Z` start. Later receipt, graph and browser traffic is outside these timing windows.

The complete comparison receipt supports the report's mixed result. Idle postload `/loopies` shared median fell from 19.96 to 8.53 ms with ten observations per endpoint. Matched-load direct maximum rose from 621.04 to 1,815.88 ms and shared maximum from 994.76 to 6,518.37 ms, with six observations per cell. The primary interval grew from 695,333 to 836,280 ms; its mixed-endpoint p95 rose from 886.79 to 2,529.62 ms. Backend median duration rose from 384 to 757 ms and p95 from 564 to 1,574 ms. These are not an overall performance improvement.

Direct HTTP includes transport, server scheduling and body reads. Shared timing additionally includes the filesystem API-slot wait and buffering. Backend-slot wait is a different queue. Small-sample percentiles are observed maxima, not reliable tail estimates. Native copied-SQL plans cannot attribute live HTTP delays to SQL, and this 528-run workload does not establish the future 100,000-run workerd budget. Live metadata R2 read counts and write amplification were not measured by these HTTP captures.

The read-queue assessment identifies a source mechanism, and its controlled reproduction passes two trials with 50 assertions. I independently checked raw monotonic events: six same-workspace read bodies completed after the explicit provider release, and two warmed other-workspace controls completed during the hold. Each trial has one synthetic admission, no watchdog release and resource-close evidence. Raw trace and derived summary hashes match the report, and all six final source pins match current bytes. The executed test/fixture pins differ from their final pins because of disclosed formatting and typed metadata corrections; the final full check exercises the final files. This establishes blocking under those controlled conditions only. It neither changes production behavior nor identifies the cause or fraction of historical workload latency. No read bypass, composite-response change or claimed performance fix belongs to this candidate.

The host bounded model reports depth eight, 1,652 abstract states and 4,687 outgoing transitions per budget at budgets one and two. The sandbox review reports depth seven, 56 states and 702 transitions. They check their finite abstractions, with separate selected SQL traces and directed boundary tests. They do not prove arbitrary graphs, unbounded outages, wide-graph fairness, physical power-loss behavior or exactly-once arbitrary external effects. Progress requires eventual provider/storage recovery and delivered wakes. The Docker proof uses real local workerd and containers, controlled response faults and graceful reconstruction; it does not prove remote Cloudflare behavior or arbitrary delayed-command fencing.

# Incident, browser and evidence policy

The prior fixture incident remains a real boundary violation in the record. Unmarked temporary Registry callers inherited the personal ancestor marker during tests. Root stopped the exact check and evaluation child, copied and removed five provenance-checked synthetic registry files, and retained private quarantine. The incident receipt has five removed entries and expressly says there is no pre-test snapshot of obsolete entries. Historical absence of an obsolete same-name record cannot be proved. The corrected fixtures add explicit project boundaries and an ancestor-sentinel test; production discovery is unchanged. Passing later tests does not erase the incident. I read only its exact receipt metadata, not personal registry or quarantine contents.

The retained populated-dashboard screenshot visibly agrees with 528 runs, 64 failures, zero awaiting/running and 15 definitions. The browser report also retains representative retry history. This is representative UI evidence, not exhaustive accessibility, browser compatibility or node-level verification. No browser was opened by this reviewer.

The explicit `biome.json` policy change is acceptable within this scope. The diff adds only an override for `.notes/cloud/evidence/architecture/**` and `.notes/cloud/architecture/evidence/**`, raises those files' parse-size limit to 16,777,216 bytes, and disables only their formatter. Global formatting and production/test rules retain their previous settings. The linter was already globally disabled; this change does not disable it. Parsing and the other configured checks remain applicable. Keeping capture bytes stable preserves the recorded hashes. Root reports a scoped 49-file check passed; this reviewer did not execute that command. The current policy hash is `b9ba870610e17c39643a0f832bea0a36de1d44eb7aea98cda4c0aab4b45be3a1` and is outside the workload freeze.

# Remaining gates

The final evidence handoff closes the local outcome, identity, scoped-census, daemon, controlled queue-proof and repository-check gates. The final cohort prose now agrees with its completed JSON. `final-check.json` records exit zero for `bun run check`, build/lint/typecheck passed, and 1,283 tests passed, three skipped, zero failed, 671,228 assertions and 112 files in 79.20 seconds. Its SHA-256 matches the retained log. Check 4 is superseded for this purpose. All original 467 frozen files still match after that check.

One proposed measurement item remains open. `proposal.md` requires workload R2 read counts and write amplification; `performance-repeat.md` expressly says it did not instrument them. The collector's 1,560 terminal resolutions, unit-level cold/warm read assertions, and retained row counts do not establish live workload read counts or amplification. `RESULTS.md` accurately separates the grouped-count mechanism and unmeasured grouping time, but should also state this R2/amplification gap explicitly. The smallest closeout correction is a clear deferred-measurement sentence with no cost improvement claim. Completing the original measurement item would require new instrumented evidence or an explicitly authorized scope deferral. This is an evidence-completeness limit, not a new source finding or a request for this reviewer to run another workload.

Root must retain these exact working-tree pins when committing. Any later source change invalidates affected evidence. Root verifies main is clean/current, integrates only the verified candidate without overwriting unrelated work, and records the integration commit. The user authorized that integration and the resulting automatic watcher reloads. This review does not perform it. Actual cloud provisioning, remote execution and deployment remain unapproved.

# Final closeout claims and pins

`RESULTS.md` agrees with the retained local outcomes, adapter ownership, mixed performance, native first-node observation, schema boundary and incident limitations. Its warm zero-R2-read statement is supported by focused real-workerd adapter tests; it is not a live workload counter. Its claim of no status-transition write amplification refers to the discarded totals-table design, not a measured absence of all added storage work. The controlled queue proof is correctly presented as a mechanism reproduction with production unchanged and no historical-tail attribution. No unbounded formal proof, general exactly-once effect guarantee, schema-16 migration, Modal acceptance or remote-cloud authorization is claimed.

The daemon lane's `playground-daemon-final-checks.json` pins an earlier `daemon-repeat.md` before root's disclosed timing paragraph and typo correction. Its other non-database evidence pins match. The final document hash below pins the reviewed prose; it does not silently alter the historical lane manifest. This report also pins source additions outside the 467-file workload freeze, so the final check is not misrepresented as using only the older manifest.

| Additional source or final document | SHA-256 |
| --- | --- |
| biome.json | b9ba870610e17c39643a0f832bea0a36de1d44eb7aea98cda4c0aab4b45be3a1 |
| packages/loopy/_tests_/workspace-read-queue.test.ts | d013021d51535ad5d61c9f8d71ecca8e21614862dd59202807683850f7a581d9 |
| packages/loopy/_tests_/fixtures/workspace-read-queue-provider.ts | 0a445a692f88a4c92e09d9e1a5fe8df5f3002e1309a37c5ed598bba50015621f |
| .notes/cloud/architecture/RESULTS.md | 13fdcda3ce78edd4436780d507c6990e9205f051eab55f613b0039c9069f9b4d |
| .notes/cloud/architecture/cohorts-repeat.md | f20c034ac3d0e4da8f886ae6ebb870a5dc9b26f0308e95591962eebb461c68a4 |
| .notes/cloud/architecture/closed-snapshot-repeat.md | c55f4b6d3dc5e55bc69aafb5a7d55f6d8692449b706a03797ae881e38c23d48f |
| .notes/cloud/architecture/daemon-repeat.md | 7169ef644fa00df45b0a7d49bc5f29f23f25ab60a6d1e19968fdaacda70f4630 |
| .notes/cloud/architecture/performance-repeat.md | 9ed8a2e37558f5d185b9937b45eab2cc427f4d752d744d09ba597feec7c0a69d |
| .notes/cloud/architecture/read-queue-assessment.md | 9675ad3ad2ef551f6a9f32b0936cb021a6f219c1cbe72244a044aefd43370855 |
| .notes/cloud/architecture/proposal.md | 667d5c59fe6cf958d4daac6890dd511669c98f21e06d936dba34e5fb68bfee9b |
| .notes/cloud/architecture/WORK.md | 4077cf2cb0786d3a125a3cd6ca4d6fff5eb395d8d0d80cb648ab8de0dadd8787 |

# Final evidence pins

Paths in the following table are relative to `.notes/cloud/evidence/architecture/` unless stated otherwise. Semantic receipts gained their completed census/log evidence before these final hashes were taken; their earlier partial-state hashes are superseded here. Raw timing captures retained their original bytes.

| File | SHA-256 |
| --- | --- |
| source-freeze.json | 34369d678d2d9baf06841c5309e066c2e0b6aacf0d934d03c922d98bf73d682c |
| playground-driver-primary-a.json | e0afabd3e224f07769c1a88ed1ca41d7c4472f680ec92e4aee9c82a86ceebcd4 |
| playground-driver-primary-b.json | f367b6fb657027c66a593f8e35184b10f8b195e17b4881db40c6ee2c2e98f576 |
| playground-driver-primary-c.json | 50b76b01f3bcadc2f7ae063dccf1408bc5ad8cb43c9f20c7907561a38e7b9829 |
| playground-cohort-a-semantics.json | b0d81618d3e9ba8ea478ee564cf2ce94667c08cdbb4f8c1ca53c3f1371089373 |
| playground-cohort-b-semantics.json | cc2934ccd4b28f75a3cb854d712a973e2910a149aff02531a219a4b285617706 |
| playground-cohort-c-semantics.json | 124e21d26061a408d4b17b06f4d942b072714216342f44185bdd00a134a0f714 |
| playground-durable-receipts.json | 12584e00b3a09b7abecdd0bdc162d96cd56947f986df76d4479849c12f72b843 |
| playground-performance-postload-inventory.json | b696b825df4d99123ada33abc48a4c6092239bb9244877aba0d27e6608b63983 |
| playground-performance-runtime.json | 1b4fd59bcb7e4763e0912f3a1e82245f9d9ec85e2c020034b69f6953c9e4ad2d |
| performance-repeat-api-measurement-done.json | 3bec68d11107fd78239400be21ee0b3c94f30e923c73695de2e1c7c2770a0030 |
| playground-daemon.json | d468f5cd0ff940608de0f9cdf27c624126064dba1c0044ecc8734d16e4ed07aa |
| playground-daemon-execution-checks.json | 3c6bbfb11462483fc7e74f5225b41290948d062efc5ec61e2edd318380987e23 |
| playground-daemon-executions.json | 328dccc0c1fc7b252d7b439d05ffbc7478d53081650b7ccb7c6a73f312b91788 |
| playground-daemon-offline-checks.json | 6d01ef682764870b50326a5e578f2723c49cec89e4ab7fe849fcda5de226ac41 |
| closed-snapshot.json | e2033728610b2e97415ecc7558776b84f567fa244550e9dcbc28369f9df478e9 |
| closed-snapshot-reconciliation.json | 516a3cf6b6e40eb3a4d3c016e89bffbea4067973d22c04b915702e05f32a3f05 |
| final-check.json | dd97a844ca4b453dc2638e015d95d5307d74bc87d309a8f99d3cb1f7b9e6ad99 |
| performance-repeat-final-manifest.json | 7eec7d8777c7d6863b092d1f1cdb6639598103d63c20ea325836fea7f51751f7 |
| performance-repeat-cloud-sql-validation.json | 924ffcae2a26dae95b20c3192795652b73cb8aee69c7b3b393d7d9d068a446c9 |
| .loopy/architecture-tests/check-final.log | 280c49ddd30bdbf7f33945f234b1233e5d39a75bde593e5082da3e571cce8a9d |
| .loopy/architecture-tests/registry-isolation-incident/receipt.json | 4e0884d1462ec8d81e824887338ce26491517855bc48c44d2f0350df9292081a |

Read-only Git identity/diff commands, bounded `rg`/file reads, image viewing and inline Python file-evidence checks are the only verification commands run by this reviewer. Earlier exploratory summaries included one local integer/list shape error, corrected by inspecting the actual receipt shape. No acceptance assertion was inferred from that failed summary command. The report is a new Markdown file, with zero source/test additions or deletions by this reviewer.
