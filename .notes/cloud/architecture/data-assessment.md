# Data and read-model assessment

Assessed source: branch `cloud-integration`, HEAD `6ffecdf`, on 2026-10-23. This is an assessment for the root's Fable 5.1 review before implementation. Only this note is owned by this task. No implementation, database opens, API requests, service operations, workload launches, commits, delegation or remote deployment occurred.

## Recommendation for this round

1. Fix the unfixed `scopeItems` variable-limit failure while preserving the 200-item contract.
2. Separate definition summaries from executable graphs. Use `get(slug)` for start and schedule validation, and metadata reads for run and loopy views.
3. Add exact counts grouped by `workspace,slug,status`, maintained inside the authoritative run transaction. Use them only when neither time bound is supplied. Keep time-filtered counts and overview on the current exact SQL query.
4. Migrate existing schema-15 stores through both native and portable initialization. Preserve the native 13/14 migration chain. Backfill cloud definition summaries separately from the shared store migration because that backfill needs asynchronous R2 reads.
5. Treat persisted payload previews as a bounded follow-on candidate, after the first slices pass equivalence and migration checks. Retain the existing scope projection and feed scan semantics this round. Do not add speculative indexes or aggregate tables for every query.

The proposals reduce known repeated work. The available measurements do not prove that any of these changes will remove the observed HTTP tails.

## Source findings and evidence limits

- `packages/loopy/src/service/service.ts:49` and `:185` use `registry.list().find(...)` for a single schedule target and a single start target. `ArtifactRegistry.get(slug)` already exists and cloud lookup already uses the primary key on `artifact_definitions`.
- `service.ts:266-325` resolves run descriptions by listing whole registries for each workspace. `:464-535` lists definitions, then performs a count, latest-10 query and pending-hook lookup for each selected definition. The request cache avoids repeated registry loads within the request, but each cloud `list()` still loads all current graphs.
- `apps/cloud/src/artifacts.ts:65-107` lists SQL publication pointers, then reads each graph sequentially from R2, parses it and checks its revision hash. A single `get()` reads one pointer and one graph. Limits are 1,000 definitions, 1 MiB per graph and 32 MiB of current graph bytes. Limits bound one request; they do not make loading all graphs necessary for a description.
- `packages/loopy/src/store/sqlite/query-runs.ts:109-136` groups authoritative runs for counts and enumerates run workspaces. `:168-185` groups current run statuses into buckets by creation time. This is a current-state distribution, not historical status at bucket time.
- `query-runs.ts:50-53` computes payload byte sizes on every preview read. `query-nodes.ts:43` removes `inputView` and possibly output from JSON at read time. Attempts have their own preview expression at `query-nodes.ts:195-198` and preserve `inputView`.
- `packages/loopy/src/store/sqlite/nodes.ts:73-107` already maintains `node_runs`, historical `node_attempts` and `node_scopes` together. Each scope ancestor gets a membership row with the current execution status. `scopeCounts` counts distinct materialized item indices and counts execution memberships by status. These are different quantities.
- `packages/loopy/src/store/sqlite/events.ts:110-118` commits SQL before publishing transaction listeners. `runs.ts`, `nodes.ts` and `waits.ts` contain several paths that change authoritative run state. Counting only `finish_run` effects would miss claims, suspension and release.

The completed performance report is `.notes/cloud/playground-performance.md`, especially lines 71-115. It records 525 primary cloud runs with expected outcomes, plus three separate preflights, for 528 retained runs. The copied cloud store had 4,721 current node rows, 4,746 attempts and 604 scope memberships. The daemon comparison had 45 serial workflows, 457 current node rows and 72 scope memberships. These are prior evidence, not work repeated by this assessment.

Native warm-query medians were 0.012 ms for all-status counts, 0.034 ms for latest runs, about 1.269 ms for log candidates and 0.835 ms for event candidates. Native timings excluded application filtering and view construction and did not measure workerd SQL. Direct HTTP probes under load were slower than post-load probes, but did not isolate SQL, R2, request serialization or transport as the cause. No new index follows from those measurements.

## Cost notation

- `N` is retained runs across the stores included in a request.
- `D` is current saved definitions across the registries included in the request. Deleted definitions can still have runs.
- `M` is current node executions. Let `h` be maximum scope depth, so scope membership rows are at most `M*h`. Historical attempts are `A`, which can exceed `M` through retries.
- `U` is distinct historical run identity pairs `workspace,slug`, with `U <= N`. `P <= 200` is a run or scope page size. `B` is bytes in the payloads or graphs actually processed.

These are row/byte work estimates, not latency predictions. B-tree seeks add logarithmic cost. A global definition can include runs from several workspaces, so counts cannot assume `U == D` or that one slug identifies one workspace.

## Slice 1, fix scope pagination first

At `query-nodes.ts:120-124`, the second `scopeItems` query uses three fixed bindings plus one binding per selected item. A 97-item selection uses 100 bindings, and 98 uses 101. The root reports reproducing 97 success and 98 failure on local workerd with 205 scope rows. This task verified the source mechanism only; it did not independently run that reproduction.

Replace only the dynamic membership predicate with:

```sql
AND item_index IN (SELECT value FROM json_each(?))
```

Bind `runId`, `nodeId`, `parentScope`, and one serialized array of selected numeric indices. This makes four bindings at every permitted page size. Preserve the first query's optional status filter, `limit + 1` lookahead, item ordering and cursor. The second query must still count every status for each selected item, rather than filtering its counts to the requested status.

The existing `node_scopes_items` index starts with `run_id,map_node,parent_scope,item_index,status` and already fits this lookup. No new index is needed. Selected-list serialization costs `O(P)` and matching membership aggregation remains proportional to memberships for those items, up to `O(M*h)` in the worst case. The JSON binding changes parameter growth, not the underlying count semantics.

Binding audit of the shared SQLite store and cloud artifact/scheduler source found one remaining generated per-item placeholder list: this scope query. `pendingHooks` already uses one JSON array plus time, two bindings total. Dynamic `AND` filters have a fixed set of fields. `pruneEvents` uses a database subquery for its transaction list, not a bound application list. Scope writes, artifact writes and scheduler writes loop with fixed-arity statements. Any new batch count or metadata lookup must also use a single JSON array or fixed-arity statements, never one placeholder per definition or run.

## Slice 2, definition metadata and single lookup

### Internal contract and callers

Keep `ArtifactRegistry.get(slug)` for consumers that need the full current graph. Change start and schedule target selection from `list().find(...)` to `get(slug)`, preserving their current `not_found` service result when the target is absent. A corrupt existing graph is still an error; do not quietly treat invalid artifact data as missing metadata.

Add a summary schema derived from existing contract schemas, with these exact fields:

```text
slug, revision, source, savedAt, scope, description, input, schedule, mode
```

`input` is the public display value, including `"schema"` when `graph.inputValidation.root === "json"`. `schedule` is the definition's declared default, before the mutable store schedule is combined into the view. The remaining fields use their existing saved-definition types. Define the schema once and infer the TypeScript type. Do not copy the full `SavedLoopy` shape or include executable bundles, nodes, secret names or input validation internals.

Replace the internal graph-list contract with `listSummaries()` and add `summary(slug)` returning a summary or explicit absence. Run views need only metadata for their selected slugs. Fetch those distinct slugs once per canonical workspace and cache within the request. `/loopies` uses `listSummaries()` and passes the already loaded summaries to run view construction. Full graph, pinned run graph, source and execution paths keep their existing lazy artifact reads.

The native adapter can initially derive summaries from `Registry.list()` and `Registry.get()`. It preserves project/global file precedence and requires no new on-disk registry format. This removes accidental full-list work on a single native lookup, but native summary listing still parses `O(D)` saved files. Do not claim that native listing stops reading embedded graphs without a separate file-format change.

### Exact cloud table

Add a cloud-owned derived table, separate from receipt and scheduler tables:

```sql
CREATE TABLE artifact_definition_summaries (
  workspace TEXT NOT NULL,
  slug TEXT NOT NULL,
  revision TEXT NOT NULL,
  generation TEXT NOT NULL,
  summary_json TEXT NOT NULL,
  PRIMARY KEY (workspace,slug)
);
```

`artifact_definitions` remains the authoritative current publication pointer. Immutable R2 graph bytes remain the source for rebuilding the summary. `summary_json` contains exactly the schema above. The primary key is the only proposed index. Store both revision and generation so a summary cannot be accepted for a replaced pointer, including publication metadata changes.

On save, validate the compiled artifacts and write immutable bundles, source and graph before publication, as today. In the existing synchronous publication transaction, retain the owner/generation checks and capacity accounting, publish the pointer and upsert its summary with the same generation. A same-save early return must repair or verify a missing summary without changing `saved_at` or inventing a new generation. A SQL failure rolls back both pointer and summary. R2 writes completed before failure may remain unreferenced, as with the existing save protocol.

Listing selects pointer rows joined to summaries only when both revision and generation match. Preserve pointer ordering, canonical workspace identity, definition limits and current project/global resolution. Preserve the service's current slug-based first-selected view behavior in this round; changing cross-workspace presentation is a separate API decision. Count storage still keys every workspace and slug correctly.

### Backfill and errors

Schema DDL can run synchronously, but R2 reads cannot run inside the store's synchronous migration. On first summary access after reopening an old cloud store, enumerate missing or mismatched summary rows. Read and validate each pinned graph under existing artifact byte limits, then publish the summary in a short transaction only if its pointer generation and revision still match. Fetch outside the transaction. If a save wins, discard the stale result and resolve against the new pointer rather than installing stale metadata.

This is a finite migration/repair path, not an alternate steady-state graph-list implementation. Fail the affected request with an actionable error if a required published graph is missing or invalid. Do not return fabricated empty descriptions or an apparently complete partial definition list. Existing run references with genuinely absent definitions still show the existing null description. Generation matching prevents stale publication metadata; it does not detect out-of-band deletion of an R2 graph after a valid summary was created. The summary endpoints will no longer read that graph on every request. Full graph and start validation must retain missing/hash-invalid artifact failures. Treat that narrower artifact-check timing as an explicit internal behavior change for review.

Steady-state cloud single lookup changes from `D` R2 graph reads and `O(B_all_graphs)` parsing/hashing to one graph read for execution validation, or zero graph reads for a run description. Cloud summary listing reads `O(D)` small SQL rows and zero graphs. Metadata storage is `O(D + B_summaries)`, with summary bytes bounded by the projected fields rather than node/bundle bytes. Cold backfill reads up to `D` current graphs, under the existing 32 MiB current-graph budget. Publication adds one summary upsert, plus its serialized metadata bytes.

## Slice 3, exact no-time-filter run counts

Add this shared-store derived table:

```sql
CREATE TABLE run_status_totals (
  workspace TEXT NOT NULL,
  slug TEXT NOT NULL,
  status TEXT NOT NULL,
  count INTEGER NOT NULL CHECK (count >= 0),
  PRIMARY KEY (workspace,slug,status)
);
```

Its authority is `runs`, never the event outbox. Retained events can be pruned, so event replay cannot reconstruct these totals reliably.

Maintain totals with store-owned SQLite triggers for run insertion, changes to `workspace,slug,status`, and deletion. Use a guarded update trigger only when those values actually differ. Insert increments the new key. A changed key decrements the old key and increments the new one. Deletion decrements the old key. Retain zero rows or remove them consistently; this recommendation removes them after decrement so active rows represent positive groups. A missing old total during an ordinary decrement is a projection error and must abort the transaction, not silently become zero. Enforce that with the trigger's explicit existence/count check before decrement. Foreign-key deletion does not delete other definitions' totals.

Triggers fit this small synchronous invariant because all current run-changing paths use the same SQLite table. They cover direct `finishRun`, effect-based finish, claim/recovery, suspend/release and a creation already in terminal status. Heartbeats, retry deadlines and wait resolution that only changes `wake_at` must not change totals. Do not count emitted run events: one operation can emit multiple records without multiple status changes. Install each complete trigger as one statement; the current schema helpers split ordinary DDL on semicolons and cannot split a `BEGIN ... END` trigger body safely. Verify trigger execution and rollback through the actual local workerd driver before accepting this mechanism.

For `runCounts`, use totals exactly when `from === undefined && to === undefined`. Aggregate with the requested workspace, slug and status filters and fill absent statuses with zero using the existing helper. A global definition's slug-only filter sums across workspaces, as today. If either time bound exists, execute the existing `runs` query. `/loopies` can fetch the needed totals once and map them by identity, avoiding one count query per definition. A single grouped read is sufficient at current limits; no general query planner is needed.

Do not promise constant-time global counts. The table has at most six rows per historical identity, `O(U)` rows, and `U <= N`. Exact workspace-and-slug counts read at most six rows. Slug-only or global totals can scan `O(U)` rows without another index; that is acceptable here and must be stated. Current definition count `D` does not bound historical groups after definitions are removed. A batched `/loopies` counts read is `O(U + D)` mapping work instead of repeated run-table grouping. Each real status transition adds two bounded aggregate updates with `O(log U)` lookup cost. It also adds write amplification to the existing run transaction; measure that under the same workload.

Do not persist mutable current run status into old logs or events. The feed query deliberately joins `runs` to filter by current status. A historical status copy would become stale at every claim, suspend, retry and finish, or require rewriting history. Totals are a separate current-state projection with a complete update rule.

## Overview, scopes, previews and indexes

Keep `overview` on authoritative runs. Its API permits fractional `from` values, arbitrary bucket widths of at least 60 seconds and up to 744 buckets. A fixed hourly rollup cannot exactly answer buckets whose boundaries cut through an hour. Exact support would require raw-run fallback for every partial rollup interval, plus status delta maintenance in each run's creation-time bucket. For this round the full exact fallback is simpler: `O(N_window)` matching rows, worst-case `O(N)`, with a bounded bucket response. Time-filtered counts have the same explicit fallback. No hourly table is proposed.

Keep `node_scopes` as the transactional scope projection. Rebuild it from each current `node_runs.record` execution scope, one membership for every ancestor, using the existing canonical ordered scope serialization. Retry history must not multiply memberships. Scope count totals remain distinct materialized item indices, and status counts remain execution membership counts. The query already caps returned map groups at 200, but computing their summaries can visit `O(M*h)` memberships. Scope pagination needs the binding fix now; new aggregate scope tables are not justified by the 604-row captured dataset. Large native-map fixtures are useful equivalence coverage, not evidence that another maintained aggregate table is necessary.

The next payload candidate, if selected for this implementation round, has these exact derived columns:

```text
runs:
  input_bytes INTEGER NOT NULL
  output_bytes INTEGER NULL
  input_preview_json TEXT NOT NULL
  output_preview_json TEXT NULL
node_runs:
  output_bytes INTEGER NOT NULL
  preview_record TEXT NOT NULL
node_attempts:
  output_bytes INTEGER NULL
  preview_record TEXT NOT NULL
```

Backfill and maintain using the exact current preview expressions in `query-runs.ts:50-53` and `query-nodes.ts:43,195-198`. An omitted run output remains SQL NULL, while an explicit JSON null remains JSON text. Run input/output preview text becomes `'null'` only when its UTF-8 JSON size exceeds 16,384 bytes. Node bulk previews remove `inputView`; attempt previews retain it, and selected execution detail retains the original current node record. Node byte counts are zero for non-succeeded current nodes. Attempts use the existing JSON output expression and nullable byte semantics. Do not substitute string length for byte length, truncate JSON text, or change full payload/detail endpoints.

Compute the columns during `insertRun`, both run-finish paths and node/attempt upserts inside their current transaction. Update explicit insert column lists, especially today's four-value `node_attempts` insert. Heartbeats must not recalculate payload previews. A failed node batch must roll back preview and full records together. A shared implementation should own each serialization and preview transformation; schema-owned inferred types should replace duplicate handwritten shapes.

This moves byte measurement and JSON modification from repeated reads to writes. It adds `O(N + M + A)` derived row fields and duplicated preview bytes. Small run payload duplicates are each bounded at 16 KiB; node/attempt preview records also retain other fields, so their total size is not bounded solely by that cap. Writes still process `O(B_changed_payloads)`. Reads avoid rescanning full output blobs, but their selected preview bytes and remaining JSON still cost work. Preserve this candidate as lower priority than metadata/counts unless the root accepts its extra schema and write cost.

No new indexes are recommended in this round. Existing run cursor indexes, node scope index, scope item index, log run/id index and event run/sequence index already serve the relevant shapes. Exact new projection primary keys are listed above. Measure native and workerd query plans and rows examined under actual filters before proposing additional composites.

`query-feeds.ts` reads at most 2,001 candidates and applies many filters after SQL. `scanPage` exposes `scanned`, `next`, `hasMore` and `scannedToAt`, including continuation through pages with no matches. Pushing filters ahead of that candidate window changes those fields and can change which matching rows appear on a page. Preserve this behavior now. Do not add FTS for the existing case-insensitive substring predicate or declare a feed-filter rewrite behavior-preserving without accounting for the scan window.

## Existing-data migration and rebuild

Use the next shared version, schema 16, if the totals or preview schema ships. A version bump alone would reject existing cloud stores: `schema.ts:85-110` currently accepts only the exact meta version, whereas native `local-schema.ts` also has a PRAGMA-based 13/14 chain.

The shared migration must have these paths:

1. Fresh native and portable stores create the new tables and selected preview columns. Native sets both `PRAGMA user_version` and meta schema version. Portable uses its existing meta version authority.
2. Native 13/14 first runs the existing wait/query migration to the schema-15 layout, then the new read-model migration. Do not mark version 16 immediately after applying only the old query schema. Portable 15 applies the same new read-model migration. Do not claim portable 13/14 support unless separately implemented and required.
3. Native 15 migrates even if a meta marker needs reconciliation with its current PRAGMA authority. Portable 15 must migrate before the current exact-version rejection. Keep unsupported populated stores intact and rejected.
4. Within one synchronous migration transaction, add the selected schema, rebuild totals with `SELECT workspace,slug,status,count(*) FROM runs GROUP BY workspace,slug,status`, backfill any selected previews, install totals triggers and verify aggregate sums before changing the version marker last. Skip publication of ordinary runtime events for derived backfill. Failure rolls back DDL, data and version together.
5. Reopening version 16 must not replay deltas, double counts or allocate a new epoch. Rebuild derives totals from runs and previews from full stored JSON, never from an existing projection or retained event history. An explicit maintenance rebuild should replace derived data atomically under the same write exclusion, without replaying executor effects.

The shared migration must not touch cloud receipt/turn tables. Root will coordinate a bounded file list and separate ownership for those tables. The artifact summary table/backfill remains cloud-registry owned. Preserve publication pointer revision, source, save time, generation and artifact size accounting. Never rewrite immutable graph, bundle, source or execution receipt bytes as part of a read-model migration.

Migration work is `O(N)` for counts and `O(B_run_payloads + B_node_records + B_attempt_records)` if previews ship. Index construction and grouping can add sorting costs and temporary space. Cold summary backfill is `O(D)` graph fetches and `O(B_current_graphs)` parsing/hash work. The current data sizes are modest, but large-store migration duration, native WAL growth, workerd transaction limits and cold summary latency remain unmeasured. Do not promise a bounded migration duration from row count alone.

## Required implementation checks after review

No checks below ran in this assessment. Use existing dedicated `_tests_` suites and disposable test state. The root owns Fable 5.1 review before implementation, full checks, workload authorization and merge decisions.

- Add native and actual local workerd scope cases with at least 205 distinct items. Check limits 97, 98, 100 and 200, contract rejection at 201, continuation 200 plus five, empty tails, gaps in item indices, nested parent scopes and a status-filtered selection whose returned counts contain other statuses. Native success alone cannot establish the workerd binding fix.
- Extend the current local workerd run-pagination test, not its public limit. Keep unresolved, resolved, expired and deadline-boundary hook coverage through 200 rows. New batched metadata/count operations must remain below the same runtime binding ceiling.
- Compare totals against direct `runs` grouping after create, claim, suspension, release/recovery, retry scheduling, wait registration/resolution/expiry, cancellation and both finish paths. Include terminal creation, no-op/duplicate writes, failed owner fencing, multiple effects in one transaction and injected failure after an aggregate mutation. Verify listener events publish only after success. Use native SQLite and local workerd, with the memory store as a query-semantic reference where applicable.
- Exercise a global slug across workspaces, a project slug, a deleted definition with retained runs, an absent definition and time bounds supplied independently. Compare every status, including zero values. Overview tests must retain fractional boundaries, non-hour bucket widths and zero-filled buckets. Test that a status change updates current-state counts and leaves historical event/log records unchanged.
- For summaries, prove zero R2 graph reads in warm run/list views, one graph read for a single start validation, generation-safe concurrent save/backfill and atomic failure between pointer and summary writes. Verify absent definitions, malformed/missing published graphs, same-save repair, public `"schema"` input display, schedule default precedence and unchanged pinned historical graph/source behavior. Keep the local registry's project/global behavior.
- If previews ship, compare old expressions against stored previews for missing output, JSON null, nested objects, escaped strings, multibyte UTF-8 and byte lengths just below/at/above 16,384. Cover retries retaining older attempts, wait outputs, selected detail retaining `inputView`, rollback and both native/workerd outputs.
- Build disposable populated schema-15 native and portable fixtures. Also require copied-schema-15 migration proof from the root-approved quiesced cloud and daemon sources. This is separate from a fresh-state workload rerun. Have the state owner supply approved copies; this task does not authorize opening any existing database. Pin copy identity before migration and compare row/identity digests afterward, allowing only declared derived schema/data changes.
- Verify preserved run IDs/statuses/revisions/payloads/owners, node execution keys and attempts, receipt fields, waits/tokens and resolutions, schedules and versions, log IDs/per-run sequence/usage, all event sequences/transaction IDs/records, epoch and next sequence allocation. Include cloud turns/receipts and artifact publication pointers where present, plus immutable artifact hashes. Test migration interruption rollback and second reopen. Existing 13/14 native fixtures must still migrate through the complete chain and preserve their records.
- After equivalence and migration checks, repeat the same 525 cloud and 45 daemon workloads in fresh isolated state with the root's existing guards and workload mix. Keep preflights separate from primary counts and preserve controlled failure/hold semantics. Reuse matched probes, report requests and failures by endpoint, and measure added projection write cost as well as saved reads. These workloads establish behavior under that load; they do not prove migration safety or identify a latency cause by themselves.
- Run `bun run check` before any push. Source tests, local workerd contracts, copied-data migration results and workload results are separate acceptance evidence. Remote deployment remains unapproved.

## Assessment completion

Source reads used `rg --files`, `rg -n`, `cat`, `sed` and `nl`. Read-only git commands returned branch `cloud-integration`, HEAD `6ffecdf` and an initially clean short status. The assessment added this 192-line note and removed zero lines. A final status also showed a concurrent change to `.notes/cloud/tasks.json`, which this task did not touch. No tests were added, moved, deleted or run. No production behavior changed. No indexes were benchmarked, databases opened or remote tools invoked. The root-reported 97/98 scope result is explicitly attributed above.
