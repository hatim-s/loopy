# Runtime and read-model quality review

## Verdict

The scoped changes make Loopy easier to reason about overall. I found no correctness blocker and no actionable code-quality regression with enough evidence to justify a fix. The service extraction adds navigation and forwarding, but the host policy and definition read paths have clearer responsibilities than before. This is a source-only review, not execution acceptance.

I classified the bundle as a major architecture refactor with authorized related fixes. I did not treat that bundle as a scope defect. I formed this assessment without reading other reviewers' reports, prior acceptance verdicts, architecture proposals, implementation reports, or recorded performance results.

## Source pins and method

- Worktree: `/Users/hatim.shakir/projects/loopy/cloud-integration`.
- Verified branch: `cloud-integration`.
- Verified HEAD: `9d30ca923d168e299099758e0d95f3db3ba81cf0`.
- Primary comparison: `6ffecdfd60e16aaa335467684d918b3cd8b44813...9d30ca923d168e299099758e0d95f3db3ba81cf0`.
- Reverse log: `69de89c` changes architecture and policy; `7f6976a` records workload/recovery/scaling evidence; `9d30ca9` records integration/watcher verification. The recorded results were not used as review evidence.
- The specified scoped source selection changes 32 files, with 1,525 lines added and 1,014 deleted. This includes new summary behavior, so it is not a measure of extraction overhead alone.
- Read `AGENTS.md`, `unslop`, `pr-review`, `typescript-codebase-craft`, and the craft references for architecture, TypeScript and tests. Also read worktree guidance. Used current code and the pinned base as the source of truth, without memory-derived code claims.

Read the full scoped source diff, including the removed service implementations, and followed the current route, event, registry and executor contracts. Static inspection included test bodies and fixtures. No checks, code-importing tests, services, ports, APIs, Docker, workloads, databases, personal state or credentials were accessed. No mutation probes were run.

## Prioritized findings

There are no P0-P2 correctness findings and no P3 cleanup recommendations from this lane. The observations below explain that result. They are not requests to redesign the modules or delete safeguards.

## What improved

### Admission policy no longer rewrites a reducer transition

At the base, `host/rate-limit.ts:14` accepted a complete transition and an in-flight identity set, searched for unchecked dispatches, called `step` again for a denial, and merged effects back into the original transition. Understanding admission required following both admission and reducer orchestration through that helper.

At HEAD, `packages/loopy/src/host/rate-limit.ts:12` checks one dispatch and returns a typed `rate_limited` event or no denial. Its two callers are `host/activation-work.ts:125` and `host/durable-work.ts:57`. The local loop reloads persisted nodes before reducing the event at `host/activate.ts:41`; the durable loop reconstructs state for each commit at `host/durable.ts:126`. Admission no longer constructs synthetic executors or owns reducer transitions.

This is a useful shared policy boundary. Local execution still owns its asynchronous pending work, and durable execution still owns bounded turns and receipts. Combining those execution loops would conceal real differences.

### Shared activation planning captures an actual invariant

`packages/loopy/src/host/activation-plan.ts:15` partitions persistence and work effects and suppresses suspension while retrying or rate-limited nodes retain the slot. Both activation loops commit the resulting store effects before invoking executor/provider work. The durable base already had the retention rule inline; HEAD gives both hosts the same rule.

This helper earns its existence. It expresses the relationship between retry retention, suspension and persisted effects rather than merely renaming a filter. The shared completion formatter at `host/completion-event.ts:4` also removes two equivalent success/failure event mappings.

The tests inspected for admission races, denial attempt fencing, retained slots and targeted polling cover meaningful boundaries. They should remain even though the resulting source is shorter.

### Durable receipt polling has a narrow query

The base rebuilt an entire engine state to find the node being polled. HEAD uses `packages/loopy/src/host/durable-work.ts:33` and the new `Store.getNodeRun` contract. The memory implementation clones the selected node at `store/memory-nodes.ts:15`; SQLite reuses its existing node decoder at `store/sqlite/nodes.ts:36`.

The lookup still checks status and attempt before acting on a receipt. It still fails an execution as uncertain when a previously recorded started receipt disappears. Avoiding repeat receipt writes at `host/durable-work.ts:82` does not remove that protection. This is less reconstruction work and a clearer dependency, without a second recovery model.

### Summary reads have an explicit contract and storage owner

The base's portable `ArtifactRegistry.list` returned full saved definitions. Service view enrichment consequently loaded unrelated graphs and bundle metadata. HEAD separates `listSummaries`, `summary` and direct `get` in `packages/loopy/src/service/registry.ts:13`. `contract/definition-summary.ts:5` derives the summary schema from existing schemas, and its formatter retains the existing JSON-input presentation rule.

`service/definition-catalog.ts:5` now owns request-local canonical workspace aliases, list reuse and absent-summary caching. The current callers create it per resolution or per loopy-list request. The cache is not retained across saves or requests. A completed list is also the absence authority for that request, so resolving recent runs does not issue redundant individual reads.

The local adapter deliberately continues to derive summaries from local registry entries. Cloud SQL holds the derived projection. These are different persistence implementations behind one metadata contract, rather than duplicate service policies.

### Publication and repair keep the important transaction boundaries

`apps/cloud/src/artifacts.ts:82` reads and verifies the immutable graph outside a SQL transaction during cold summary repair. `artifacts-definitions.ts:118` then checks the current generation before inserting its projection. If a replacement wins during the read, repair returns the current pointer rather than attaching old metadata to it.

Publication at `apps/cloud/src/artifacts-definitions.ts:140` rechecks source ownership, generation and capacity in the transaction that writes the pointer and projection. The identical-save branch preserves generation and saved time while repairing derived metadata. R2 uploads remain before SQL publication. This ownership split is easier to audit than mixing these SQL operations into artifact transport code.

The separate projection table is justified by the row-size boundary, including existing large source metadata. It is not dead compatibility code that can safely be removed just to reduce file count. The inspected workerd tests cover replacement during cold backfill, rollback, identical-save repair and large escaped/multibyte metadata.

### Counts and scope queries stay with the store

`packages/loopy/src/store/sqlite/query-runs.ts:133` computes grouped counts directly from authoritative runs. Memory implements the same grouped shape at `store/memory-query-runs.ts:83`. The service's `definitionCounts` only combines those groups for project/global display selection; it does not maintain another mutable counter.

At the base, `listLoopies` issued one count query per displayed definition. HEAD makes one grouped count call at `service/run-views.ts:104`. Recent runs remain bounded and filtered per selected definition. The caller-first, first-slug selection behavior remains in the loop. This is a sensible optimization without triggers or a separately maintained aggregate table.

`store/sqlite/query-nodes.ts:122` replaces variable-length SQL bindings with one JSON array binding. The membership and all-status aggregation remain in the query owner. The inspected tests explicitly exercise the old workerd binding boundary at 97/98 items, rather than merely checking the replacement SQL string.

### Missing definitions are distinguished from storage failures

The base converted arbitrary failures from graph/source lookup into `not_found`, and start/schedule searched a full list for one definition. HEAD uses direct `get`. The native adapter translates only `RegistryMissingError` into absence, while malformed files and other storage failures propagate. Cloud `get` also supplies a coded missing-definition failure.

The metadata path can return a null description for a deleted definition without treating corrupt existing storage as deletion. These are useful behavior changes, not just moved methods.

## Readability tradeoffs and existing debt

These observations are deliberately below the actionable-finding threshold.

- The portable service facade shrinks from 702 to 206 lines, while it and the six new service files total 862 lines. Some of the added size is forwarding and composition. Schedules, mutations, queries and enrichment now have clear files, so I would keep the split. I do not see a concrete caller problem that would justify flattening it again.
- `service/mutations.ts:10` takes a `Pick<LoopyService, "requireRun" | "runGraph" | "view">`, and the facade passes itself. This creates a type-level dependency back to the facade. It is a modest navigation cost, but the dependency is narrow and has no runtime import cycle. Introducing another accessor abstraction solely to remove this type reference would be preference-driven here.
- `service/run-views.ts:54` keys descriptions by the `RunRecord` objects supplied to its resolver. This is less obvious than an identity-keyed cache, but every inspected caller passes those same objects, including `serverEvent`. I found no current failure mechanism to report.
- The JSON-input presentation expression also appears in cloud row-budget preflight at `artifacts-projection.ts:62`. The repetition is small and the size/publication tests exercise agreement. I would not introduce a helper or larger intermediate object solely to remove this expression.
- Recent-run reads still happen per displayed definition, and workspace discovery still has a separate query. Both query patterns existed at the base. The new grouped count path improves one cost without claiming to batch every list query. This review does not turn the remaining work into a new regression.
- The memory store's inherited class chain and the broad `Store extends DashboardReader` contract predate the range. `memory-query-runs.ts` adds one level to that existing arrangement, with a coherent run-query responsibility. I found no new ownership violation requiring a parallel store redesign.
- `runGraph` still catches all pinned-graph read failures and exposes `not_found`. That is preexisting behavior, unlike the improved current-definition lookup path. I did not relabel it as a regression from this refactor.

## Inspected paths

Full changed-source inspection covered:

- `packages/loopy/src/host/{activate,activation-plan,activation-work,completion-event,durable-work,durable,rate-limit}.ts`.
- `packages/loopy/src/core/{queries,store}.ts`.
- `packages/loopy/src/store/{memory-nodes,memory-queries,memory-query-runs}.ts` and `store/sqlite/{nodes,query-nodes,query-runs}.ts`.
- `packages/loopy/src/service/{definition-catalog,input,mutations,queries,registry,run-views,schedules,service}.ts`.
- `packages/loopy/src/local/{daemon,registry,service}.ts`.
- `apps/cloud/src/artifacts{,-definitions,-projection,-storage,-validation}.ts`.
- `packages/loopy/src/contract/definition-summary.ts` and the related index export.

Caller/context inspection included `service/{index,routes,events,views}.ts`, `host/durable-wake.ts`, `core/{executor,revision}.ts`, `engine/{step,invoke}.ts`, `contract/{compiled-loopy,derive}.ts`, `store/sqlite/driver.ts`, and `apps/cloud/src/artifacts-capacity.ts`.

Test source inspection covered `host-{admission-race,denial-fence,slot-retention,targeted-polls,policy-model}.test.ts`, their policy model/replay/fixture modules, `definition-summaries-{service,workerd}.test.ts`, `definition-summary-size.test.ts`, summary service/size fixtures, `readmodel-{counts,scopes,workerd}.test.ts`, shared readmodel assertions, `registry-isolation.test.ts`, and the changed portions of `cloud-service`, `dashboard-queries`, `dashboard-scale-fixture`, `registry` and `service` tests.

## Commands and limits

Commands were static `pwd`, `git branch --show-current`, `git rev-parse HEAD`, `git status --short`, `git log --reverse`, scoped `git diff` with name/status/stat/numstat modes, `git show` of base source, `rg`/`rg --files`, `cat`, `sed`, `nl`, `wc` and an `awk` sum of scoped numstat. Branch and HEAD matched the requested pins. The initial status showed an untracked quality-review directory. Scoped `git diff --check 6ffecdf...9d30ca9` returned no output and exit code 0. The only write was this assigned report.

I did not run `bun run check` or any tests, and do not claim the inspected tests passed. I did not inspect the broader `dee31da...6ffecdf` cloud baseline or review receipt-authority, sandbox, workload tooling or dashboard implementation lanes. The before/after attribution here is against `6ffecdf`. Runtime timing, provider behavior, database plans, resource use and deployment acceptance remain outside this source-only review.
