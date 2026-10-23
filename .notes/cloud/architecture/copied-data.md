---
title: Copied schema-15 read-model verification
status: same-backend acceptance passed
date: 2026-10-23
base: 6ffecdfd60e16aaa335467684d918b3cd8b44813
---

# Result

Required acceptance passed. Current native SQLite opens the approved daemon
schema-15 copy. Current portable SQL opens the approved cloud meta-schema-15 copy.
Portable SQL also opens the daemon copy. The cloud-to-native attempt is explicitly
unsupported and preserves the exact rejection below. No format conversion or
PRAGMA user_version stamping was performed.

| Source | Adapter | Schema markers before and after | Result |
| --- | --- | --- | --- |
| Cloud | Portable SqlRunStore with BunSqlDriver | meta 15, user_version 0 | Pass, required |
| Daemon | Native SqliteRunStore | meta 15, user_version 15 | Pass, required |
| Daemon | Portable SqlRunStore with BunSqlDriver | meta 15, user_version 15 | Pass, additional |
| Cloud | Native SqliteRunStore | meta 15, user_version 0 | Unsupported cross-adapter open |

The unsupported open reported:

```text
Database schema 0 cannot be opened by this runtime. Preserve this home and migrate its saved definitions into a separate home.
```

That rejection reflects the historical cloud/native marker distinction. It is not
a failed required acceptance case. Its copy remains logically unchanged after the
rejected open. The initial exploratory run treated all four opens as required and
exited 1. That evidence remains in
.loopy/architecture-tests/copied-data-a191mt/evidence.json. The final runner reports
required and unsupported cases separately, following the clarified acceptance.

# Approved inputs and preservation

The supplied daemon filename exists, so no alternate file discovery was needed.
The reusable runner searches only the specified daemon root, by the supplied hash,
if that filename is absent. It never SQLite-opens candidate originals.

| Input | SHA-256 | Bytes | mtime in ns |
| --- | --- | ---: | ---: |
| .loopy/playground/diagnostics/quiesced-postload-20261022T203547958718Z/standalone/diagnostic.sqlite | 0d0ce744814caf442edf3c3fde3e74b129019f7602db4bb393a431cd341697fa | 23035904 | 1792701407108146068 |
| .loopy/playground-daemon/daemon-readonly.sqlite | 5f83e877a93e335e4f5ac5d1586c5dea9db6523bf9de9614dd8c377774297771 | 2506752 | 1792701667817884874 |

Cloud has no WAL, SHM or rollback-journal sidecar. Daemon has no WAL or rollback
journal. Its retained SHM sidecar is 32,768 bytes, mtime
1792701667817408914 ns, SHA-256
fd4c9fda9cd3f9ae7c962b0ddf37232294d55580e1aa165aa06129b8549389eb.

Every original and sidecar retains its existence, byte hash, size and mtime across
verification. Only filesystem byte reads and stat calls touch these approved
originals. All SQLite connections receive fresh copied paths. The runner asserts
that raw snapshot connections are inside its unique copied-data directory.
Nonempty source WAL bytes would reject copying rather than silently omit data.
Only the approved standalone main-file bytes are copied; the stale daemon SHM is
fingerprinted and preserved in place.

# Exact data checks

Every separate copy starts with the supplied main-file hash. PRAGMA integrity_check
returns ok, and PRAGMA foreign_key_check returns no rows, before and after adapter
opening and reads. The complete ordered sqlite_schema result is identical. Every
table, including SQLite's sequence table and cloud-specific metadata tables, has
an identical row count and SHA-256 of sorted complete JSON-encoded SQLite rows.
JSON payload fields remain strings in this digest, preserving their stored text.
No output is previewed or truncated. This checks logical cell contents; SQLite
journal-mode headers and copy-side WAL files need not be physically identical.

The exact sorted run ID/workspace/slug/status lists are retained in the JSON
evidence and compared before and after each adapter attempt:

- Cloud has 528 unique run IDs, 464 succeeded and 64 failed, and no other statuses.
  All 18 tables retain their content digests. Epoch is
  2ed0b19e-4fa3-4ec7-9071-8519cf0dc29a and event cursor is 16913.
- Daemon has 45 unique run IDs, 39 succeeded and six failed, and no other statuses.
  All 12 tables retain their content digests. Epoch is
  dfb30868-f890-42f9-8742-f6b8802fe3f1 and event cursor is 1321.

For each successful adapter, runCountsByDefinition matches a direct authoritative
SQL GROUP BY over runs. Every workspace/slug identity is compared with existing
runCounts filters. Rows summed by slug across all workspaces also match existing
global slug filters. Cloud checks 15 identities and 15 slug filters, with 25 grouped
rows. Each daemon adapter checks five identities and five slug filters, with ten
grouped rows. These historical datasets each contain one workspace; this check
preserves their observed identities and global sums. Multi-workspace behavior is
covered by the separate synthetic read-model tests.

# Commands and evidence

The final commands were:

```sh
bunx biome check packages/loopy/_tests_/fixtures/readmodel-copied-data.ts
bunx eslint packages/loopy/_tests_/fixtures/readmodel-copied-data.ts
bunx tsc --noEmit -p .loopy/architecture-tests/copied-data-checks-r9__w3ki/tsconfig.json
bun packages/loopy/_tests_/fixtures/readmodel-copied-data.ts
```

All exited 0. Biome printed Checked 1 file, No fixes applied. ESLint and TypeScript
printed no diagnostics. The runner printed passed=true, failure=null and all four
case classifications, including the exact unsupported-open error.

Exact expanded commands and outputs are saved in
.loopy/architecture-tests/copied-data-checks-r9__w3ki/{biome,eslint,typecheck,verification}.log.
The compiler configuration includes only this fixture and its imports, using the
repository compiler options. During fixture development it caught ES2023 toSorted
against the repository's ES2022 target. The runner now sorts a copied array and
passes without changing compiler settings.

Final copies and a matching evidence.json live in
.loopy/architecture-tests/copied-data-kUXdtz.
The reviewable machine record is
.notes/cloud/architecture/evidence/copied-data.json.
Runner SHA-256 is 37fac8262ac4526c83fa4484898387e643cd4b7eef2c4610e191c60cb875dd0b.
Machine record SHA-256 is d698280475ac9d4d1dc9512d383ab9a421e0fbe2f608fa57b989da0b46cdfd08.

This follow-up adds the manual fixture runner, this note and its machine evidence.
No production file or existing test was changed. No tests were removed. No source
schema, migration, trigger or totals table was invented. No live API, service,
Docker, fullcheck, commit or child task was used. This is copied-data correctness
acceptance, with portable SQL backed by local Bun SQLite. It is not a fresh workerd
execution or a latency measurement. Root owns final workload timing.
