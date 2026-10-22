# Pagination review 1

## Verdict

Approve the narrow bug fix. No blocking or actionable correctness finding in the four scoped files. This is one minor bug fix: restore the existing 200-row run-list contract on workerd by reducing the pending-hook lookup from `1 + ids.length` SQL bindings to two.

Reviewed branch `cloud-integration`, HEAD `f692e0f0df17d71c86e2572acce9740307ddb7c1`, plus the uncommitted changes identified by the final hashes below. Read the repository AGENTS.md, the supplied user instructions, unslop, pr-review, TypeScript codebase craft and its TypeScript reference, worktree-management, and `.notes/cloud/pagination-fix.md`.

Only this report was added. No source edits, commits, delegates, cloud calls, Docker calls, live database access, credentials, daemon actions, or full repository checks.

## Cause and semantics

- `packages/loopy/src/store/sqlite/query-runs.ts:139-151`: the old query has one placeholder inside `PENDING_HOOK` for `now`, followed by one per run ID. A 99-row page therefore uses 100 bindings; 100 and 200 rows exceed the runtime's measured limit. Changing only the membership predicate to `IN (SELECT value FROM json_each(?))` removes that exact cause. Binding order remains `now` first, the ID array second.
- `query-runs.ts:17-20,149`: the correlated scalar subquery, run-status restriction, node-status restriction, unresolved/unexpired predicates, strict `wakeAt > now` comparison, and `LIMIT 1` remain unchanged. The expiry projection still comes from the matched node record. This patch changes no hook-selection policy.
- `query-runs.ts:139-165`: input is typed `string[]`. `JSON.stringify` produces JSON strings that `json_each` returns as SQL text; it does not interpolate IDs into SQL. The `runs.id` column is TEXT. The outer query still selects each matching run once, so duplicate IDs do not multiply rows, missing IDs do not create rows, and a run without a pending hook is omitted from the map. Empty input still returns before SQL execution. Parsing and map keys are unchanged.
- `packages/loopy/src/service/service.ts:267-301`: callers select hooks by `hooks.get(run.id)`, so membership-query row order does not affect page order or association. The page query still orders by descending creation time and ID. No truncation, chunk merge, extra query, fallback, schema migration, or new runtime dependency was added.
- `packages/loopy/src/contract/api.ts:91,367-374` and `query-runs.ts:80-102`: the request maximum remains 200, and the store cap remains 200. The fix does not reduce the contract to the previous working limit of 99.

An additional isolated Bun SQLite comparison checked old/new membership predicates across 11 string IDs, including numeric-looking strings `1`, `01`, and `1e0`, quotes, a backslash, JSON punctuation, Unicode, and `__proto__`. Six selections passed with identical IDs, SQL types, and cardinality, including duplicates and missing IDs. Workerd compatibility is established separately by the actual regression test, rather than inferred from Bun SQLite.

## Regression effectiveness

`packages/loopy/_tests_/fixtures/cloud-pagination-probe.ts:16-88` seeds 205 runs through production store operations, with 200 pending hooks. All runs share a timestamp, so cursor completeness depends on the ID tie-breaker. The other five cases are a resolved hook, a hook expired by run completion, a hook due exactly at `now`, a queued run without a hook, and a succeeded run without a hook.

`cloud-pagination-probe.ts:96-131` uses the actual DurableSqlDriver, SqlRunStore, LoopyService and API dispatcher. `cloud-worker.test.ts:194-300` executes that path inside a SQLite Durable Object under local workerd. It checks:

- Exact successful page sizes at 99, 100 and 200.
- Exact descending IDs and all 205 IDs across cursor pages, with no omissions or duplicates.
- Each pending hook's name, token, sequence, expiry and creation time associated with its own run, including IDs beyond the old boundary.
- Null `waitingOn` for the five nonpending cases, 200 waiting runs with distinct tokens, five nonwaiting runs, and an empty final page.
- HTTP 400 for limit 201.

I independently reran the named regression on the fixed source. It passed with 1,241 assertions.

I also independently restored the two old SQL expressions in memory during Bun bundling, without editing source or writing a bundle file. The same probe seeded a separate ephemeral workerd SQLite DO. Its three boundary requests returned:

```text
limit=99  -> status 200, 99 rows
limit=100 -> status 500, {"error":"too many SQL variables at offset 693: SQLITE_ERROR"}
limit=200 -> status 500, {"error":"too many SQL variables at offset 693: SQLITE_ERROR"}
```

This negative control confirms that the regression reaches the failing SQL and detects the measured bug. It also rules out a test that passes only because it exercises Bun SQLite or silently shrinks pages.

The expired-hook fixture is also a terminal run, so it does not independently isolate the `expiredAt` predicate from the run-status predicate. That is a coverage limit, not a blocker for this patch: both predicates are unchanged, the seeded expired state is asserted, and membership cardinality and boundary failure are directly exercised.

The probe bypasses Worker credential routing and Workspace scheduling. It proves the local workerd/DO query and shared API semantics. It does not establish acceptance of the separately restarted populated stack. The parent-reported 525-run workload, 461 successes, 64 controlled failures, and planned 528-record API verification were not independently inspected here.

## Checks performed

```sh
bun test --timeout 60000 packages/loopy/_tests_/cloud-worker.test.ts --test-name-pattern 'workerd run pages'
```

```text
(pass) workerd run pages retain all pending hooks through the 200-row contract limit [150.75ms]
1 pass
10 filtered out
0 fail
1241 expect() calls
Ran 1 test across 1 file. [493.00ms]
```

Two additional commands were `bun --no-env-file -`, each receiving an inline script. The first bundled the existing probe with `write: false` and an `onLoad` transform of only `query-runs.ts`, restoring the original placeholder list and `.all(now, ...ids)`. It ran the three boundary requests recorded above and disposed the ephemeral Miniflare runtime in `finally`. Exit 0.

The second used only `new Database(":memory:")`, compared old/new membership results and `typeof(id)` for six ID selections with `isDeepStrictEqual`, then closed the database in `finally`. Exit 0, output:

```text
6 old/new predicate comparisons passed across 11 string IDs; duplicates and missing IDs preserve cardinality.
```

```sh
git diff --check -- packages/loopy/src/store/sqlite/query-runs.ts packages/loopy/_tests_/cloud-worker.test.ts packages/loopy/_tests_/fixtures/cloud-worker-probe.ts
```

Exit 0, no output. The new fixture was read in full. The implementer's separate 22-test, lint and TypeScript results are documented in `pagination-fix.md`; I did not rerun those broader checks.

Tracked change counts from `git diff --numstat`: production query +3/-2, worker test +112/-1, existing probe +5/-0. The new probe has 132 lines. Total scoped changes are +252/-3. No tests were deleted or moved. The only production behavior change is the ID-set binding strategy.

## Final identity

Final branch and HEAD remained `cloud-integration` and `f692e0f0df17d71c86e2572acce9740307ddb7c1`. SHA-256 values matched the initial review read and the implementer's report:

```text
8383ce0afc84e83047397e0606a6fa1ad1ea9950bb1443540c6750d2ee101728  packages/loopy/src/store/sqlite/query-runs.ts
2b899e8091c8612b2d83c2ae7899605ccf4cc4242fe2cc1bc957122b566d485f  packages/loopy/_tests_/cloud-worker.test.ts
5501a131d60997a4f2903dfd00b8701a8e80013cbbb19782cefd2b3922c52796  packages/loopy/_tests_/fixtures/cloud-worker-probe.ts
d136bbdc27b36977afe733d8937cd5c6044a3aa97b3dbaf24349b34d94ed7788  packages/loopy/_tests_/fixtures/cloud-pagination-probe.ts
```
