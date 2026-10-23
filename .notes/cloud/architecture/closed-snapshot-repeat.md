---
title: Closed architecture workload snapshot
status: verified
date: 2026-10-23
batch: playground-architecture-2026-10-23T15-18-37-705Z
head: 6ffecdfd60e16aaa335467684d918b3cd8b44813
---

# Result

The current architecture batch has a verified stopped copy of both Workspace and SandboxReceipts. Workspace exactly matches all 528 IDs and statuses in the postload API inventory, with 464 successes and 64 failures. SandboxReceipts exactly matches all 1,560 collector attempt IDs, execution identities, workspaces, request hashes, session epochs and immutable result references. The runtime queue and Workspace backend-attempt identities match the same set. There are no extra attempts, started receipts or active export guards. All 464 retained export guards are inactive. The attempt split is 1,552 primary and eight preflight.

All four SQLite files, including the two DO metadata databases, were backed up and reopened as standalone main files with read-only integrity results of `ok`, journal mode `delete`, and no standalone sidecars. The 15 retained graph definitions remain present.

# Paths for metrics and cohort analysis

Workspace standalone database:

`/Users/hatim.shakir/projects/loopy/cloud-integration/.loopy/playground-architecture/diagnostics/closed-snapshot-20261023T160158250238Z/standalone/loopy-playground-architecture-local-Workspace/c9fc980e43ecc368c89f7bc55f965f1da91aa94aa0bd54dd7515a5a571209ad3.sqlite`

SHA-256 `05ac0b40f0c0bbcfd69f8e04a470324a6d6c5632256d099e89e9ae8388d213d4`, 23,818,240 bytes.

SandboxReceipts standalone database:

`/Users/hatim.shakir/projects/loopy/cloud-integration/.loopy/playground-architecture/diagnostics/closed-snapshot-20261023T160158250238Z/standalone/loopy-playground-architecture-local-SandboxReceipts/327ae8e1d510b59f55607b6f29df0ffcd50c61848a5c5f6a2a9eaa14d2171e74.sqlite`

SHA-256 `4e0c0316db77d23e5fcfd4f83298b82e88acee544cd3f44df28199a4d9a04a8e`, 2,367,488 bytes.

The metrics approval is `/Users/hatim.shakir/projects/loopy/cloud-integration/.loopy/playground-architecture/diagnostics/closed-copy.json`. It has exactly the workload profile's five fields: `profile`, `sourceClosed`, `path`, `sha256` and `batch`. It approves the Workspace standalone path above with `sourceClosed: true` and the current batch. It was written only after closure, integrity, identity reconciliation, preservation and source-freeze verification passed.

The metrics lane may pass the approved Workspace path to its existing architecture `metrics-sql.ts postload` command. The cohort lane may query that same standalone copy read-only for scoped node analysis. This lane did not run their analysis commands.

# Closure and preservation

Root provided the fresh ROOTCLOSED gate after its existing ownership-verified stop command returned zero for supervisor and PGID 35171. This lane sent no signal. The first independent check found all 10 recorded PIDs absent, no members of PGID 35171, ports 15270 through 15273 free, and no open handles in the source DO tree. Final checks again found no original process identities or process-group members, no owned listeners and no open source handles. PID 35389 had been reused by ChatGPT's `node_repl` under PGID 35366; its command and group differ from the original workerd. No action targeted that foreign process.

Port 4310 still belongs to PID 81432 and port 4173 to PID 41194. Ports 14870 through 14873 and 15070 through 15073 were absent in root's baseline and remained absent. All protected listener observations match the baseline.

The full DO tree is retained under `/Users/hatim.shakir/projects/loopy/cloud-integration/.loopy/playground-architecture/diagnostics/closed-snapshot-20261023T160158250238Z/raw/do`. All eight files, totaling 30,391,856 bytes, include every Workspace and SandboxReceipts database and metadata WAL/SHM sidecar. Full path, size, nanosecond mtime, mode and SHA-256 records match source-before, source-after-copy, raw-copy and final observations. Source and raw were never opened by SQLite. They remain unchanged.

The full raw tree was copied again into a disposable working tree. SQLite opened working databases with `mode=ro` and backed them up into separate writable destinations. Only backup destinations received `PRAGMA journal_mode=DELETE`. Each destination was closed before its main file was copied into the standalone directory. Standalone copies were reopened with `mode=ro`; integrity and all identity comparisons passed. Destination SHM remnants are retained beside the backup destinations. No immutable flag was used.

The checkpointed main DO files retain WAL mode but have no WAL sidecar. SQLite 3.43.2 rejected initial read-only main-file access until an empty WAL was created beside each disposable working copy. This adjustment touched working files only. Existing copied metadata WAL/SHM files were preserved. There was no writable SQLite connection to source, raw or working databases.

# Reconciliation details

The exhaustive evidence records every safe run ID and every receipt ID, execution key, attempt, workspace, request hash, session epoch, volume and result reference. It also records every inactive export guard's safe attempt identity, volume and helper, without export tokens. All 1,560 receipt identity hashes were independently recomputed using the configured sandbox root and canonical identity JSON. SQL identity columns and projected record identities agree.

Workspace contains 4,721 node runs and 4,746 node attempts. Its 1,560 backend attempts have finished receipts. Their stored statuses are 1,519 succeeded, 16 failed and 25 historical retrying attempts. All 25 historical failures have a finished second attempt and matching current node state. Twenty-one successors succeeded and four failed. Those historical retrying rows are completed failed attempts, not started authority receipts or unfinished executions.

The collector resolved and hashed immutable result bytes before shutdown. This offline check proves exact equality with its stored result references and compares result kinds against runtime outcomes. It does not independently reread R2 bytes or enumerate unreferenced blobs.

# Evidence and retained failures

- `.notes/cloud/evidence/architecture/closed-snapshot.json` records closure, preserved tree metadata, standalone hashes, manifest, source freeze and failures.
- `.notes/cloud/evidence/architecture/closed-snapshot-reconciliation.json` records the exhaustive safe run and receipt inventories, inactive exports and verified retry histories.
- `/Users/hatim.shakir/projects/loopy/cloud-integration/.loopy/playground-architecture/diagnostics/closed-snapshot-20261023T160158250238Z/copy-stage.json` retains the raw-copy and backup-stage observations inside ignored state.
- `/Users/hatim.shakir/projects/loopy/cloud-integration/.loopy/playground-architecture/diagnostics/closed-snapshot-20261023T160046701547Z` retains the first raw and working copies, the empty-WAL probes and failed zero-byte backup destination. Its raw tree still exactly matches source. This directory is not approved for analysis.

An initial hash helper used unavailable `hashlib.file_digest` and failed before filesystem writes. It was replaced by chunked SHA-256. Initial comparison assertions incorrectly required every failed backend result to have stored node status `failed`, then required all retry successors to succeed. Read-only inspection established the exact historical retry semantics above, and the final checks verify both terminal successor outcomes. The initial final-closure assertion also treated a reused PID as the old process; the final check uses the original full command identity and process group. All failures remain described in the evidence.

# Boundaries

All 467 frozen source files and the source-freeze manifest file hash match. The recorded aggregate remains `93e0bcd0fccac0dbf8deff30aa0eb9e4b18ec15cac090c2ec6d8cb00ae8edc52`. No source edits, tests, builds, Docker operations, new runs, stack restarts, commits, remote actions or child agents occurred. Raw private receipt data remains only in ignored diagnostics. Tracked evidence uses projected safe fields and contains no session nonce or credentials. These observations concern stopped local storage only.
