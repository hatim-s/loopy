---
title: Grouped run counts and bounded scope queries
status: implemented, focused checks pass
base: 6ffecdfd60e16aaa335467684d918b3cd8b44813
date: 2026-10-23
---

# Implementation

This lane implements the reduced read model in proposal.md and fable-review-1.md.
Branch remains cloud-integration at the starting HEAD. No commit or push was made.

The public contract in core/queries.ts is available through core/index.ts's existing
wildcard export. This lane did not change any index.ts file.

```ts
export type RunDefinitionCount = {
  workspace: string;
  slug: string;
  status: RunStatus;
  count: number;
};

runCountsByDefinition(): Promise<RunDefinitionCount[]>;
```

DashboardReader owns the method, so Store inherits it. SqliteQueryRuns and
MemoryQueryRuns implement the same signature. Rows contain only observed identity
and status combinations, with positive counts. Row order is unspecified. Each call
returns detached values. There is no filter argument.

SQL executes one query with no bindings:

```sql
SELECT workspace,slug,status,count(*) AS count
FROM runs GROUP BY workspace,slug,status
```

Memory groups the authoritative runs using a JSON tuple identity, preserving
workspace/slug values that would collide under delimiter concatenation. Existing
runCounts filters and time windows keep their behavior. The service lane consumes
these rows once and owns mapping them to workspace-specific definitions and global
slug totals across workspaces.

ScopeItems' aggregate membership query binds run id, map node, parent scope and one
JSON numeric array, exactly four bindings. Selection still uses its existing query,
optional status filter and one-row lookahead. Aggregation still includes every node
status for selected items. The 200-item limit, ascending numeric cursors and empty
page behavior remain unchanged.

Memory run query methods moved unchanged from memory-queries.ts into
memory-query-runs.ts before adding grouped counts. This keeps the two owners at
153 and 118 lines. No existing tests were removed, moved or rewritten. Existing
store query expectations needed no changes.

# Focused evidence

All new fixtures use fresh unique directories under
.loopy/architecture-tests/readmodel-*. Native SQLite files, workerd bundles and
explicit workerd Durable Object persistence live there. Tests dispose their
runtime and remove their own unique directory. The existing .loopy/cloud,
.loopy/playground and .loopy/playground-daemon roots were not used or modified.

The final focused command was:

```sh
bun test --timeout 60000 packages/loopy/_tests_/readmodel-counts.test.ts packages/loopy/_tests_/readmodel-scopes.test.ts packages/loopy/_tests_/readmodel-workerd.test.ts
```

It printed 7 pass, 0 fail and 7886 expect() calls. It exercised native SQLite,
memory and actual workerd through Miniflare, without a SQL mock.

Counts were compared with individual workspace/slug runCounts queries at eight
checkpoints: empty, create, claim, release, finish, suspend, terminal outcomes and
rollback. Explicit expected status totals cover all six statuses. The fixture has
seven runs and five distinct workspace/slug identities, including a shared slug
across workspaces and delimiter-collision identities. Failed and cancelled outcomes
include both finishRun and apply's finish_run effect. A finish effect followed by an
invalid retry timestamp rolls back the changed outcome and leaves the event cursor
unchanged. Bun reports Invalid Date and workerd reports Invalid time value; each
runtime's expected error is pinned in the tests.

Native reopening retains grouped rows, complete run records and the event cursor,
including epoch. PRAGMA user_version and meta.schema_version remain 15, and the
schema definition is unchanged. Workerd's schema definition is unchanged across
writes, has no triggers and remains schema 15 after actual Durable Object eviction
and reopening. Its counts and cursor, including epoch, survive that reopening.

Scope traversal covers 213 noncontiguous numeric item indices at page sizes
97, 98 and 200, unfiltered and with waiting selection. Every returned item's
succeeded/waiting/failed counts match the fixture independently of the selection
filter. Each traversal checks complete ordered membership, cursor progress and no
duplicates. Exactly full terminal pages require next=null, proving lookahead rather
than inferring continuation from page length. Other runs, maps and parent scopes
with overlapping indices cannot affect the counts.

Two causal controls were run:

- The dedicated workerd fixture executes the old generated-placeholder aggregate
  query. 97 indices use 100 bindings and succeed. 98 and 200 indices fail with
  too many SQL variables. This is part of the seven-test suite.
- A disposable Bun bundle changes only the grouped SQL query to omit workspace
  from GROUP BY. The SQLite test fails on the expected cross-workspace per-filter
  mismatch. The memory test passes. Output is 1 pass, 1 fail and 146 assertions.
  The control wrapper requires exit 1 and those counts. Production source is not
  mutated. Run it with the command below.

```sh
bun .loopy/architecture-tests/readmodel-checks-a2b6h493/count-negative.ts
```

Formatting and lint ran on all 13 owned TypeScript files. Exact expanded commands
are saved in biome.log and eslint.log under the checks directory. Biome printed
Checked 13 files, No fixes applied; ESLint produced no diagnostics. Both exited 0.
The focused TypeScript configuration includes those same source/test files and
uses the repository compiler options:

```sh
bunx tsc --noEmit -p .loopy/architecture-tests/readmodel-checks-a2b6h493/tsconfig.json
```

It exited 0 without diagnostics. This is an owned-source check, not whole-branch
acceptance. Earlier portable-project checking intersected the summary lane while
its contract/service changes were incomplete.

Existing focused store/dashboard checks also ran:

```sh
bun test --timeout 60000 packages/loopy/_tests_/dashboard-queries.test.ts packages/loopy/_tests_/store-durability.test.ts packages/loopy/_tests_/dashboard-scale.test.ts
```

The first run printed 20 pass, 0 fail and 136 assertions, including native schema
13/14 upgrade tests. A later combined run while the summary lane was active printed
23 pass and 4 fail across six files. All seven read-model tests passed; three
existing dashboard-query tests and the dashboard-scale test failed because the
in-progress service called registry.summary before native Registry supplied it.
Root and that lane were notified. No source in those other owners was changed.

Logs and the per-file manifest are saved under
.loopy/architecture-tests/readmodel-checks-a2b6h493. The manifest pins source/test
SHA-256 bytes. The scoped source/test delta is 829 added and 102 deleted lines.
This count excludes this note and ignored disposable evidence.

# Limits and ownership

No shared schema change, migration, trigger, totals table or index was added.
Grouped reads remain O(N) in retained runs, with O(U) grouped results. This lane
makes no 100,000-run latency or HTTP-tail claim. The proposal's future investigation
trigger remains actual-workerd p95 above 20 ms at 100,000 retained runs, or measured
request-budget pressure at a smaller size.

Copied schema-15 data, live repeated workload, service mapping acceptance, complete
branch checks and integration belong to root. The fixture checks do not substitute
for copied-data checks. No main operations, commits, push, cloud execution, personal
data reads or shared-service changes occurred in this lane. No subagents were used.

# Source and test hashes

| File | Added | Deleted | SHA-256 |
| --- | ---: | ---: | --- |
| packages/loopy/src/core/queries.ts | 8 | 0 | 15f05c039108d0b2ba25f444600c1797d63e2a9ce3950903042757672f0e5ce8 |
| packages/loopy/src/store/sqlite/query-runs.ts | 9 | 0 | 45b5e48edefa14c4aef5d54802cfedca629755e272fec5d6dcd6ad68d30d535b |
| packages/loopy/src/store/sqlite/query-nodes.ts | 7 | 2 | 2d90de7acb4501ea3d1b1045475661ff90eb929ecc9b86ba558082d801102201 |
| packages/loopy/src/store/memory-queries.ts | 3 | 100 | 47af88bd39e10b4142e99c9d412c9d59c2538f475da23e8c626c83d3fbaa4d0e |
| packages/loopy/src/store/memory-query-runs.ts | 118 | 0 | d777123d65410cf96364f4f110edd11f935c3a8710a6b4a44cc3bcb852db7820 |
| packages/loopy/_tests_/readmodel-counts.test.ts | 79 | 0 | f3889b21bdaeccfb926f2d198d9cc2d942920f0254537adc650a23ecfee53941 |
| packages/loopy/_tests_/readmodel-scopes.test.ts | 32 | 0 | 65c822157d6092a49da9656dc10fa3afde101103e15b5d060345c87aaf95c4ed |
| packages/loopy/_tests_/readmodel-workerd.test.ts | 136 | 0 | ee523106102ee347a5d10a9e1772f6ec9d5a29b6b597147c1f57c2044e9ff082 |
| packages/loopy/_tests_/fixtures/readmodel-assertions.ts | 146 | 0 | fe78216e9cef0a3c1503ca135fc0e10f1924d38d98391d45d5af388592837afa |
| packages/loopy/_tests_/fixtures/readmodel-directory.ts | 9 | 0 | fcb691d0c7b9fea313a1264966732d78fe67e4572381df7711fa9ce1a78e266d |
| packages/loopy/_tests_/fixtures/readmodel-history.ts | 89 | 0 | a9d8d7b540d99e6674c9802592225105240c19a301959c61c1e75d0bda8e54c0 |
| packages/loopy/_tests_/fixtures/readmodel-scopes.ts | 90 | 0 | fca0263399d5ce665591309c40fd07250e77836375b6a55240a7154e8b72a372 |
| packages/loopy/_tests_/fixtures/readmodel-workerd.ts | 103 | 0 | 3ccaea1469856cbea0f6802b444e897660045e00306884135d0457946f415bd2 |
