---
title: Independent data and service implementation review
status: changes requested
date: 2026-10-23
base: 6ffecdfd60e16aaa335467684d918b3cd8b44813
branch: cloud-integration
---

# Verdict

Changes requested for one P2 storage-bound regression in definition summary publication and cold backfill. The grouped counts, scope JSON bindings, service extraction and normal-size summary lifecycle have no additional blocking finding in this review. Passing tests do not cover the reproduced metadata-size failure.

This reviews the dirty working source on top of the base above. HEAD remains the base commit. The primary change is a major refactor with the expressly bundled scope correction and summary feature. No PR split or approval step is requested. Only this report is a repository edit by this reviewer. Disposable evidence is under the fresh directory below. No source edits, commits, subagents, main operations, Docker, remote cloud, old database opens, personal data or credentials, or shared-service operations were performed.

# P2: Summary JSON duplicates unbounded pointer metadata and breaks supported publications

Location: apps/cloud/src/artifacts-definitions.ts:99-108 and :150-167. The projection copies source at packages/loopy/src/contract/definition-summary.ts:24. The source path is an unrestricted string in contract/compiled-loopy.ts. checkArtifactLimits caps request and graph bytes, without a separate source-path or combined SQL-row bound.

The pointer already stores source. Both repair and publish serialize the entire DefinitionSummary, including that source, into summary_json on the same SQL row. A valid pointer can cross workerd's row-size limit solely because its derived summary is added. The 1 MiB graph and 32 MiB current-graph quotas do not bound this duplicated metadata.

I reproduced this against actual local workerd and R2 using a graph with no executable nodes and source.path equal to slash followed by 1,100,000 ASCII x characters. The complete request is 1,100,472 UTF-8 bytes, below the declared 24 MiB request cap; its graph is tiny. This is an adversarial wire-valid source identity, not a claim that ordinary OS paths are this large.

| Same synthetic publication | Result |
| --- | --- |
| Base registry module from 6ffecdf saves to a fresh DO | succeeds |
| Base registry gets that publication | succeeds |
| Current registry adds its nullable column and resolves the old summary | string or blob too big: SQLITE_TOOBIG |
| Current registry saves the same body to another fresh DO | string or blob too big: SQLITE_TOOBIG |

The counterfactual uses base artifacts.ts with the same dependency implementations as the current probe. The changed artifact validation helper preserves the base limit checks. No production file was mutated. The final probe was rebuilt and rerun after the native RegistryMissingError change and summary save optimization.

Causal impact: upgrading a previously readable publication can make cold /loopies and metadata for runs referencing it fail. A fresh otherwise-valid save fails at SQL publication after immutable R2 writes. Rollback preserves the previous pointer but does not make summary access succeed. listSummaries correctly propagates the error instead of returning partial results, but the endpoint remains unavailable for this accepted publication.

Smallest correction: fix the persisted projection and its byte contract. Avoid repeating pointer-owned fields such as source inside inline summary_json, and reconstruct the public summary from its pointer plus the stored projection. Check the combined UTF-8 row budget, including projected graph metadata and JSON escaping. Removing repeated source is the first reduction, not proof that every other accepted combination fits. If publication intentionally gains a source-metadata limit, validate it before R2 writes and explicitly handle already published rows that exceed it. This does not require changing shared schema 15.

Missing assertion: create the large-source pointer in the base format in a fresh workerd DO, then assert current summary/list and run metadata remain readable and the warm repeat reads zero graphs. Cover the intended maximum source/description/input combinations and escaping or multibyte cases. For new rejected inputs, assert a clear boundary error before artifact writes, rather than raw SQLITE_TOOBIG afterward. Existing quota tests stress graph descriptions and definition counts; they miss this source field.

# Source-backed checks without additional blockers

## Counts and scope queries

SqliteQueryRuns.runCountsByDefinition executes one unfiltered GROUP BY workspace,slug,status over authoritative runs, with no bindings or persisted totals. MemoryQueryRuns uses JSON tuple keys, avoiding delimiter collisions, and returns detached rows.

ServiceRunViews calls the grouped reader once and builds workspace/slug and global slug maps once. Global definitions include matching-slug runs across workspaces; project definitions use their canonical workspace. Deleted historical identities still contribute where the original slug-only filter did. Absent status groups become zeros. First-selected slug behavior remains, including collisions between workspaces. Recent runs still require a latest-10 query per selected definition.

This removes repeated per-definition count queries. It still visits retained runs to group them, returns historical identity/status groups and maps them to definitions. SQLite grouping work and result bytes remain. There is no O(1) claim, no 100,000-run latency result and no claim that all per-definition queries disappeared. Time-filtered runCounts and overview retain exact raw queries.

The second scopeItems query uses four bindings: run id, map node, parent scope and a numeric JSON array. The first query retains status selection, numeric ordering, limit-plus-one lookahead and cursors. Aggregation counts every status within the selected items, regardless of the selection filter. It does not remove membership scan work or alter the transactional node_scopes projection.

Actual workerd traverses all 213 noncontiguous indices at page sizes 97, 98 and 200, filtered and unfiltered. The included old-query control succeeds at 97 and fails at 98 and 200 with too many SQL variables. Memory and native checks agree on counts, membership and terminal cursors. Grouped counts match authoritative per-filter queries through creation, claims, release, suspension, terminal changes, rollback and reopening.

## Summary lifecycle, quota and corruption

Actual workerd accepts nullable ALTER TABLE on the legacy six-column pointer table and retains saved_at and generation. Cold backfill reads and validates the pinned graph outside transactionSync. The repair UPDATE fences generation and fills only NULL. Concurrent replacement wins against valid, missing and corrupt old graph reads. The resolver rereads the pointer rather than publishing stale metadata. Its retry loop is finite and cold graph reads share a byte budget.

The save transaction rechecks owner and generation and publishes pointer plus summary together. Constraint failure rolls them back together. Identical saves repair NULL or corrupt summary JSON while retaining saved_at and generation; final source skips rewriting a byte-identical summary. Immutable artifacts written before failed SQL may remain unreferenced, as before.

Warm cloud summaries and service metadata use zero R2 graph reads, including summary reuse after actual DO eviction. Warm metadata can remain readable after out-of-band graph corruption. Direct get, start and schedule still read and validate that graph. Cold access to missing, invalid-JSON or hash-invalid required graphs fails without fabricated empty descriptions or a successful partial list. True definition absence returns null for metadata and typed not_found for direct lookup. Corrupt existing summary JSON remains an error until a save repairs it.

The existing 1000-definition and aggregate 32 MiB current-graph quotas remain enforced in the publication transaction. Concurrent publications cannot both consume the last available capacity. Those tests pass independently but do not resolve the P2 metadata bound.

## Native registry, service extraction and SSE

The root addition at local/registry.ts:35-39 introduces RegistryMissingError with the old final-absence message. Only the final absence branch uses it. The adapter catches that class without existence probes or broad exception swallowing. Syntax and version-2 validation failures propagate. Obsolete version-1 entries remain intentionally skipped. Project/global lookup precedence and the native file format remain unchanged. The native/portable distinction around discarded formats is not a new regression.

DefinitionCatalog caches selected slug metadata and true absence once per canonical workspace per request. /loopies loads each canonical registry once and reuses those summaries for recent-run views. Native listSummaries still parses files and embedded graphs. Zero R2 reads describes cloud behavior, not removal of native filesystem reads.

Comparison of extracted schedules, queries, mutations, input validation and run views with the base retains mutation guards, finally-release behavior, hook resolution and pinned run graphs. Start and schedule use get(slug), avoiding unrelated graph listings while preserving errors for the selected graph. Current graph/source errors now propagate instead of being broadly relabeled as absence. The schema-owned summary type preserves JSON-input display as schema and omits graphs, bundles and secret names.

Run views still derive owner staleness and payload previews through runView and query current pending hooks. Snapshot, event detail and transaction/SSE paths use the same resolver; node preview handling stays separate. Portable checks cover revision pinning, schedule workspace identity, whole-transaction delivery, abort, split cursors, epoch mismatch and pruning. The actual artifact service check also exercises a snapshot and SSE run frame. No live daemon/browser SSE claim is made.

# Focused evidence

Evidence directory: /Users/hatim.shakir/projects/loopy/cloud-integration/.loopy/architecture-tests/data-review-1-fAEuKLr5

Generated files and explicit durable/R2 persistence for my probes are confined there. TMPDIR points there for suites using node:os tmpdir. Read-model fixtures create their own fresh unique directories under this worktree's .loopy/architecture-tests and remove them. All state is synthetic. Bun uses --no-env-file and WRANGLER_SEND_METRICS=false.

Exact final commands, with reviewDir set to the absolute directory above:

~~~sh
TMPDIR="$reviewDir" WRANGLER_SEND_METRICS=false bun --no-env-file test --timeout 60000 packages/loopy/_tests_/definition-summaries-service.test.ts packages/loopy/_tests_/definition-summaries-workerd.test.ts packages/loopy/_tests_/readmodel-counts.test.ts packages/loopy/_tests_/readmodel-scopes.test.ts packages/loopy/_tests_/readmodel-workerd.test.ts packages/loopy/_tests_/cloud-service.test.ts
~~~

26 pass, 0 fail, 8005 expect calls. Log: final-focused-tests.log. Includes native version-1 absence, version-2 corruption and the extra cold invalid-JSON graph case.

~~~sh
TMPDIR="$reviewDir" WRANGLER_SEND_METRICS=false bun --no-env-file test --timeout 60000 packages/loopy/_tests_/cloud-artifacts.test.ts
~~~

9 pass, 0 fail, 143 expect calls. Log: artifacts-tests.log. These are focused artifact/service boundary checks, not branch-wide acceptance. Earlier passing runs remain in focused-tests.log and service-final-tests.log.

~~~sh
TMPDIR="$reviewDir" WRANGLER_SEND_METRICS=false bun --no-env-file "$reviewDir/size-probe.ts"
~~~

Exit 0 from the evidence collector, with the four explicit success/failure records above in size-probe-final.log. Collector exit is not a passing implementation assertion. size-worker.ts and base-artifacts.ts are disposable probes. evidence-hashes.json pins probe sources and final logs.

Read proposal.md, fable-review-1.md, read-model-implementation.md and summaries-implementation.md. The summary note became available before handoff; its listed source/test hashes agree with this review pin. Its 66-test result, typechecks, lint and five restored mutations are owner-reported evidence, not checks independently rerun by this reviewer. The independent results above remain the acceptance evidence for this report.

# Pin and limits

The full source-final.json in the evidence directory pins 70 source, test and design-note files. source-start.json retains the first pin; intervening native absence and summary/test changes were inspected before the final runs. Shared run schema and portable initialization have no diff from the base. Focused native/workerd reopen checks retain schema 15 and event epoch. No schema-16 migration or trigger table is proposed.

For the explicit source/test files below, the base-to-reviewed delta is 1977 added and 825 deleted lines. No existing test was deleted or moved in this scope. Run-query implementation moved from memory-queries.ts into memory-query-runs.ts. This count excludes the rest of the dirty branch.

Other lanes remain active. This verdict applies to the hashes below and full manifest, not future edits or an integration tree. Full bun run check, lint/typecheck acceptance, native 13/14 upgrade reruns, existing copied-data equivalence, the 100,000-run investigation trigger, repeated workload, receipt-authority lanes, main integration and deployment were not run or accepted here. Existing copied-data files were not opened. These are review limits, not additional source defects.

| File | SHA-256 |
| --- | --- |
| apps/cloud/src/artifacts-definitions.ts | c973dd5d3a231bd7066b80e705f51424b0141b27d61f7bb8a3c395e7f5064400 |
| apps/cloud/src/artifacts.ts | 9ce6fe605e0b844b9777adebf5585685eee76624be25bfa94af6059a5803d621 |
| apps/cloud/src/artifacts-storage.ts | 0c344f8f8e85181d215b02ad0032907df4b6788ce371e7469cc7eb428b256bfb |
| apps/cloud/src/artifacts-validation.ts | b84b4ba35ae75bd0a58b982b3d24eb98398281d4c4918ca5c288dd735d09ea9e |
| apps/cloud/src/artifacts-capacity.ts | ff5e583220fb88e00c017be1dafb44e0a00ed555f817f3762cc0f8ffe33da2b5 |
| packages/loopy/src/contract/definition-summary.ts | 9a25e4ffdb7fa92add10e70e7ea3df49a7a6a56ccbca708a7d16caeb6c483ed0 |
| packages/loopy/src/contract/index.ts | dd8dcca9352d3216299cf138449619d1e1e101c908341ffde8b510dc4f90a87c |
| packages/loopy/src/core/queries.ts | 15f05c039108d0b2ba25f444600c1797d63e2a9ce3950903042757672f0e5ce8 |
| packages/loopy/src/store/sqlite/query-runs.ts | 45b5e48edefa14c4aef5d54802cfedca629755e272fec5d6dcd6ad68d30d535b |
| packages/loopy/src/store/sqlite/query-nodes.ts | 2d90de7acb4501ea3d1b1045475661ff90eb929ecc9b86ba558082d801102201 |
| packages/loopy/src/store/memory-query-runs.ts | d777123d65410cf96364f4f110edd11f935c3a8710a6b4a44cc3bcb852db7820 |
| packages/loopy/src/store/memory-queries.ts | 47af88bd39e10b4142e99c9d412c9d59c2538f475da23e8c626c83d3fbaa4d0e |
| packages/loopy/src/service/registry.ts | a44827dea73b9b78a92df3c9f6423e7ab38f378fc65015facabd20f3d1982541 |
| packages/loopy/src/service/definition-catalog.ts | 201c19546efe28d004ebe6a458824054659ad11413007ef5d73ee1c3ed49639c |
| packages/loopy/src/service/run-views.ts | 913d98ceff037f832d509ed07f58c5c96d1017963908b5c03615d9df6a3c0c99 |
| packages/loopy/src/service/queries.ts | 75ab81503f13c3744d19cf1e9d3199e10bd6c94e42863e679ff286f52f675b09 |
| packages/loopy/src/service/schedules.ts | d8957ef4c5830447d7471748108fe7b60df8a3e5676e2d54bed5468c311acc0d |
| packages/loopy/src/service/input.ts | ee6ac74854e114ef002a09db619b22f9439585903bddef7b59b3cd59cf19d942 |
| packages/loopy/src/service/mutations.ts | 644a3132bb77ad48fd0a4da0bf28970df0534a474b5aafaf3662387faa6ee2fa |
| packages/loopy/src/service/service.ts | ae0fc851f2f845e2877334cff339a3501e61575ae5cbf768ed3b4d9d719e9c5a |
| packages/loopy/src/local/registry.ts | 7e411dda351b696a77f85a25bdd5a20fdab12bcd0f5f1be40270068b3dfba86c |
| packages/loopy/src/local/service.ts | 763f6914dfbbfe6b52f4b2681e6276d7beab81900b9c00c9e742c1111f51aa48 |
| packages/loopy/_tests_/definition-summaries-service.test.ts | 6f08a5b909fcd229db79d167679a1682a655e4c3dc0d4259a7308f25ee5cff46 |
| packages/loopy/_tests_/definition-summaries-workerd.test.ts | e12a8070ed8b2ff349bde2aa757a107786699522702b574b672ff27a48cdc365 |
| packages/loopy/_tests_/readmodel-counts.test.ts | f3889b21bdaeccfb926f2d198d9cc2d942920f0254537adc650a23ecfee53941 |
| packages/loopy/_tests_/readmodel-scopes.test.ts | 65c822157d6092a49da9656dc10fa3afde101103e15b5d060345c87aaf95c4ed |
| packages/loopy/_tests_/readmodel-workerd.test.ts | ee523106102ee347a5d10a9e1772f6ec9d5a29b6b597147c1f57c2044e9ff082 |
| packages/loopy/_tests_/cloud-artifacts.test.ts | 9084f719bbf9ab74a3b5fb3e54ac6878025843daa8efc43c4626c3114ca89185 |
| packages/loopy/_tests_/cloud-service.test.ts | 136627ca3b88b23147abd04d98f19a66950df86ddb0453ccaebfe3ab2d742175 |
