# Cloud run pagination fix

Implemented on `cloud-integration`, base HEAD `f692e0f0df17d71c86e2572acce9740307ddb7c1`.
Production edits began only after root's SNAPSHOT COMPLETE and EDIT GATE OPEN messages.
The populated stack stayed stopped throughout implementation. No source or snapshot database
was opened, no workflows were loaded into user state, and no service settings changed.

## Cause and change

`SqliteQueryRuns.pendingHooks` used one SQL variable for `now` and one per run ID.
The actual workerd SQLite Durable Object rejected pages containing 100 or 200 runs.
The API contract permits 200, and shortening the page would discard valid results.

`query-runs.ts` now uses `r.id IN (SELECT value FROM json_each(?))` and binds
`now, JSON.stringify(ids)`. The statement uses two bindings regardless of page size.
Actual workerd execution confirms support for `json_each` in this SQLite DO runtime.
This retains one SQL read and the existing hook predicates, per-run lookup, expiry
projection, map association, empty-input return, keyset order, and 200-row contract.
Chunking would require several reads and merge handling without improving this fix.

Only one production file changed, with 3 lines added and 2 deleted. The worker test
adds 112 lines and deletes 1 import line; its existing probe adds 5 lines. The new
test-only pagination fixture adds 132 lines. No tests were deleted or moved.

## Actual workerd regression

Runtime versions: Bun `1.4.0`, Miniflare `4.20260730.0`, workerd `1.20260730.1`.
The existing suite creates an ephemeral SQLite Durable Object and temporary bundle
directory, then disposes the runtime and removes the directory. This test creates
synthetic records only in its dedicated `pagination` probe object.

The probe uses the real `SqlRunStore`, `DurableSqlDriver`, `LoopyService`,
`R2ArtifactRegistry`, production API dispatcher, and `/api/runs` request/response
schemas. It seeds through store operations, including claims, node writes, wait
registration, resolution, and run completion. It bypasses Worker credential routing
and the Workspace scheduler. This is a local workerd/DO regression proof, not a
restart or acceptance check against the user's populated stack.

Fixture population is 205 runs sharing one timestamp to exercise ID cursor ties:

- 200 pending hooks, each with a distinct name and token. Half have no expiry.
- One resolved hook, one explicitly expired hook, one waiting hook due exactly now.
- One queued run and one completed run without hooks.

Before the production edit, this command exited 1:

```sh
bun test --timeout 60000 packages/loopy/_tests_/cloud-worker.test.ts --test-name-pattern 'workerd run pages'
```

The boundary assertion captured all three requests:

```text
limit=99  -> status 200, 99 rows
limit=100 -> status 500, {"error":"too many SQL variables at offset 693: SQLITE_ERROR"}
limit=200 -> status 500, {"error":"too many SQL variables at offset 693: SQLITE_ERROR"}
0 pass, 10 filtered out, 1 fail, 3 expect() calls
Ran 1 test across 1 file. [463.00ms]
```

After the change, the same named test passes. It checks successful 99/100/200
boundaries, exact descending page IDs, all 205 IDs across cursor pages without gaps
or duplicates, and an empty page after the oldest ID. Every pending hook's name,
token, sequence, expiry, and creation time is checked against its persisted run.
All five nonpending cases have `waitingOn: null`. `waiting=true&limit=200` returns
all 200 pending runs with 200 distinct tokens, including runs beyond position 99;
`waiting=false` returns the other five. `limit=201` remains HTTP 400.

## Focused validation

Final commands and results:

```sh
bun test --timeout 60000 packages/loopy/_tests_/cloud-worker.test.ts packages/loopy/_tests_/dashboard-queries.test.ts
# 22 pass, 0 fail, 1391 expect() calls
# Ran 22 tests across 2 files. [851.00ms]

bunx biome check --write packages/loopy/src/store/sqlite/query-runs.ts packages/loopy/_tests_/cloud-worker.test.ts packages/loopy/_tests_/fixtures/cloud-worker-probe.ts packages/loopy/_tests_/fixtures/cloud-pagination-probe.ts
# Checked 4 files in 5ms. No fixes applied.

bunx eslint packages/loopy/src/store/sqlite/query-runs.ts packages/loopy/_tests_/cloud-worker.test.ts packages/loopy/_tests_/fixtures/cloud-worker-probe.ts packages/loopy/_tests_/fixtures/cloud-pagination-probe.ts
# Exit 0, no output.

bunx tsc --noEmit -p packages/loopy/tsconfig.portable.json
# Exit 0, no output.

bunx tsc --noEmit -p /Users/hatim.shakir/projects/loopy/cloud-integration/.loopy/cloud/tests/pagination-types-49z3G3/tsconfig.json
# Exit 0, no output.

git diff --check
# Exit 0, no output.
```

The temporary scoped TypeScript config extended the repository `tsconfig.json`
and included only the changed production query, worker test, and two probe files.
TypeScript followed their dependencies. The temporary config was removed after
the check. No full repository check, build, commit, push, real-stack restart,
Docker call, cloud deployment, remote access, or credential change was performed.
Root retains the full-check and populated-stack restart decisions. Root subsequently
authorized the restart and supplied the verification receipt recorded below.

## Source hashes

SHA-256 of `query-runs.ts` before the edit and during the failing workerd proof:

```text
2bdd61c755d2fe78877f4d798e8e3ee5448fa0a14d6e7caff067b62bde255417
```

Final source is stable. SHA-256 values after the focused checks:

```text
8383ce0afc84e83047397e0606a6fa1ad1ea9950bb1443540c6750d2ee101728  packages/loopy/src/store/sqlite/query-runs.ts
2b899e8091c8612b2d83c2ae7899605ccf4cc4242fe2cc1bc957122b566d485f  packages/loopy/_tests_/cloud-worker.test.ts
5501a131d60997a4f2903dfd00b8701a8e80013cbbb19782cefd2b3922c52796  packages/loopy/_tests_/fixtures/cloud-worker-probe.ts
d136bbdc27b36977afe733d8937cd5c6044a3aa97b3dbaf24349b34d94ed7788  packages/loopy/_tests_/fixtures/cloud-pagination-probe.ts
```

## Root's populated-stack verification

Root reported an authorized restart with the existing command and unchanged private
configuration/state. Supervisor `56542` started at `2026-10-22T20:40:18.269Z`.
The implementation agent read the resulting receipt at
`evidence/playground-driver-pagination-fixed.json`; it records status `passed`,
scope `bounded-local-authenticated-pagination-read-verification`, and final
verification time `2026-10-22T20:42:20.108361+00:00`.

The receipt pins the same final production SHA-256 shown above and confirms:

- API, dashboard, and sandbox health returned HTTP 200.
- Authenticated run limits 99, 100, and 200 returned HTTP 200 with exactly 99,
  100, and 200 rows; limit 201 returned HTTP 400.
- Cursor pages of 200, 200, and 128 rows reached all 528 unique inventory IDs.
  All statuses matched, with 464 succeeded and 64 failed. There were no missing
  IDs, extra IDs, or status mismatches, and zero workflow runs were added.
- Persistent configuration, protected listener identities, the raw snapshot,
  and the standalone database snapshot remained unchanged.
- The stack remains running for browser QA.

The receipt's inventory ID/status SHA-256 is
`2ee2cf576af94fc48fdf584735e5a53dfe11fccbe455ee0908a3707d6b2e4be6`.
Root noted an initial local evidence-hashing ArrayBuffer error after assertions;
the corrected command repeated only bounded GETs and passed. This follow-up changed
only this proof note. Production source was rehashed and still matches
`8383ce0afc84e83047397e0606a6fa1ad1ea9950bb1443540c6750d2ee101728`.
Browser QA remains separate from this API pagination verification.
