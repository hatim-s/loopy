---
title: Architecture daemon repeat
status: complete, single 45-run batch verified
date: 2026-10-23
starting-head: 6ffecdfd60e16aaa335467684d918b3cd8b44813
---

# Result

The single authorized 45-run batch passed. All 39 expected successes and six
controlled failures matched their frozen fixture causes. All nine approvals
were held and resolved. The safe suspended-wait restart and same-home competing
daemon rejection passed. Both owned daemon processes stopped, port 15370 has no
listener, and the exclusive load marker remains. No rerun occurred.

Creation-to-first-node delay was 1 to 9 ms, median 1 ms and p95 5 ms across all
45 runs. Every timestamp was present and matched the earliest full stored
execution and attempt, so the analyzer's missing-value fallback was not used.
The prior report recorded 4791 to 4997 ms and a 4876 ms median. This repeat
demonstrates a much smaller recorded activation delay for this workload.
It does not measure maximum worker throughput or hardware-equivalent cloud
performance.

# Preparation result

The single authorized preparation completed successfully from
2026-10-23T15:29:12.743783Z through 15:29:24.786411Z. Five workflows compiled
and saved through the actual public CLI and owned daemon API. A standalone
backup of the stopped daemon database contains zero runs and passes integrity.
At that phase, the 45-run gate remained closed. Root opened it separately after
the cloud workload and collectors completed and the cloud stack stopped.

The command ran exactly once:

```sh
LOOPY_PLAYGROUND_PROFILE=architecture bun --no-env-file scripts/daemon-playground/prepare.ts
```

It exited zero and printed:

```text
Frozen source compiled and saved through the public CLI. No runs started; daemon stopped.
```

Stderr was empty. Runner PID 4053 exited. Owned daemon PID 4056 started at
15:29:13.005Z and was confirmed absent after preparation. Its discovery file
was removed. `lsof -nP -iTCP:15370 -sTCP:LISTEN` returned no listener, and an
IPv4 loopback bind with SO_REUSEADDR succeeded. The immediate plain bind after
exit had failed; that result alone was not treated as evidence of a live service.
No daemon restart or workflow admission followed preparation.

# Frozen sources and isolation

The worktree HEAD remains `6ffecdfd60e16aaa335467684d918b3cd8b44813`.
The upstream frozen repository is
`.loopy/playground-architecture/loopies-playground`, at commit
`95d1e5b4769f149c98692cc41897e09a80da8741`. Its tracked fixtures and marker
match that commit. Recomputing the source marker over all 47 fixture files
produced `a213d51dab78b89a140ebcc1c792daa18558d9fb428330bdc21b650400de9c89`.
The normalized fixture-tree hash is
`4623ccc20a2f9bfb824dc0f0c8ce848401ae960d336e8c21f1dabb08d5642bfa`.
These hashes use different path prefixes and are not interchangeable.

The daemon state root did not exist before this invocation. All preparation
state is under `.loopy/playground-daemon-architecture`, including execution
home `home`, process HOME `process-home`, isolated source `loopies-playground`
and the five `workspaces/<slug>` directories. Each workspace has an explicit
`.loopy/loopies` marker created before its saved definition entry. Preparation
creates those markers before daemon startup and the CLI save loop. The runtime
uses port 15370, concurrency four and lease duration 2000 ms.

The observer runtime-only digest over 278 TypeScript files in `packages/loopy/src` was
unchanged before and after preparation:
`21d9f556d7fcd706e688d1f59e86075c1ac8d4f34c478f531f225bca0a780575`.
Root separately supplied a freeze digest over 467 runtime/harness files,
`93e0bcd0fccac0dbf8deff30aa0eb9e4b18ec15cac090c2ec6d8cb00ae8edc52`.
This lane did not reconstruct that different manifest.

# Retained evidence

All evidence paths below are under `.notes/cloud/evidence/architecture`.

- `playground-daemon-preflight.json` records the five API-observed revisions,
  graph node counts, selected workspaces, source identities and zero planned
  admissions performed by preparation. Node counts are 12, 14, 4, 12 and 6
  for lint-report, parallel-build, retry-marker, repository-validation and
  security-review respectively.
- `playground-daemon-preparation-checks.json` records the exact invocation,
  timestamps, owned PIDs, source and harness hashes, workspace markers,
  shutdown checks and closed-copy receipt.
- `playground-daemon-preparation.sqlite` is a standalone zero-run diagnostic
  backup. SHA-256 is
  `11185c70093854e8f5436ebe231d9261453e8ffe96bc3bda8daff834c57dc5f2`.

The backup used the existing `scripts/daemon-playground/backup.py`, after
verified owned-daemon exit, from a read-only source connection. Only the new
diagnostic destination was finalized to DELETE journal mode. It reopened
read-only with integrity `ok`; source and copied run censuses were both empty.
The source database SHA-256 and source sidecar sizes were unchanged. No store
constructor or migration opened the diagnostic copy. No 45-run backup was
created, so the later runner's `daemon-readonly.sqlite` destination is reserved.

# Executed batch and shutdown

After explicit DAEMON45GATE authorization, the command ran exactly once:

```sh
LOOPY_PLAYGROUND_PROFILE=architecture bun --no-env-file scripts/daemon-playground/run.ts --root-load-gate
```

Runner PID 36655 started at 2026-10-23T16:00:25.355296Z and exited zero at
16:02:53.307272Z. The primary evidence interval is 16:00:25.841Z through
16:02:43.466Z, or 137625 ms. These are different capture boundaries. The root
was notified promptly on process start and after verified process exit so its
separate queue proof could remain isolated from this run.

Owned daemon PID 36701 started at 16:00:26.061Z. The first security-review run,
`ebb739c9-716d-4eb3-be51-540781f5c199`, suspended after its seed effect finished.
A competing same-home daemon exited one with the explicit already-running
error. The driver killed only its owned daemon, then restarted as PID 36832 at
16:00:26.860Z. The pending hook and finished seed receipt were unchanged across
restart, and that receipt's hash remained unchanged through final success.
This checks singleton exclusion and recovery of a safe suspended wait. It does
not prove stale per-run owner rejection or recovery during an unfinished effect.

All five workflows ran ordinals one through nine serially with unchanged input
distribution. Each had its ordinal-five controlled failure, and security-review
ordinal eight had the expected approval-denial failure. The nine holds lasted
10003 to 12013 ms, with median 11018 ms. These are the observed durations for
the nominal 10, 11 and 12 second holds. All nine retry-marker executions reached
attempt two, with contiguous stored attempts one and two.

PIDs 36701 and 36832 were confirmed absent after runner exit. The discovery file
was absent, `lsof` found no listener on 15370, and a loopback SO_REUSEADDR bind
succeeded. State, artifacts and `load-started.json` remain retained. No lock was
cleared, no ABORT file changed, and no workload was readmitted.

# Complete verification

The closed backup `.loopy/playground-daemon-architecture/daemon-readonly.sqlite`
matches all 45 unique API IDs/statuses, the primary records and the backup's
source census. It reopens read-only with integrity `ok` and DELETE journal
mode. Its SHA-256 before and after every offline check is
`ed037ac95b469b5a30616afb505fa1d2e6edfb8a4d4538250108d75a2c0b3bad`.
The source backup receipt records unchanged source WAL and SHM sizes of zero
and 32768 bytes. The diagnostic main file and retained SHM sidecar were also
byte-identical across offline analysis. The DELETE-mode main file is standalone;
the retained sidecar was not removed. No source home database was opened by the
offline verifier, and no store constructor or migration ran.

The primary evidence SHA-256 remained
`d468f5cd0ff940608de0f9cdf27c624126064dba1c0044ecc8734d16e4ed07aa`.
Complete SQL execution records, rather than API root-node snapshots, establish
457 latest executions, 466 attempts, 72 scoped executions and 400 logs. Latest
records match their last attempt; attempt histories are contiguous; log
positions are unique and refer to stored attempts.

All 178 physical receipt files are finished and map one-to-one to external
code/command attempts. Their paths, execution keys, ordered scopes, attempts,
hashes and terminal results match both captured inventories and stored attempt
records. No extra physical receipt or missing external-attempt receipt remains.
All 272 retained-file byte/hash checks and workflow semantic checks pass. All
45 stored revisions match preparation and the saved graphs. These checks cover
the recorded effects and retained artifacts, not arbitrary external exactly-once
behavior.

Offline commands were:

```sh
LOOPY_PLAYGROUND_PROFILE=architecture bun --no-env-file scripts/daemon-playground/analyze.ts
python3 .notes/cloud/evidence/architecture/playground-daemon-offline-audit.py
```

Both exited zero. The first verified 45 runs and 272 files; the second printed
`all offline checks passed`. Earlier supplemental verifier attempts rejected an
incorrect cross-format digest comparison and an assumed API revision field.
The corrected verifier compares consistent hash orderings and authoritative SQL
revisions. Production source and raw workload evidence were unchanged.

Additional evidence under `.notes/cloud/evidence/architecture`:

- `playground-daemon.json` contains inputs, IDs, outcomes, timing, restart,
  receipt and backup evidence. `playground-daemon-progress.json` retains the
  final admission progress.
- `playground-daemon-executions.json` contains all scoped nodes, attempts and
  logs from the read-only closed backup.
- `playground-daemon-semantics.json` contains semantic, file, count and timing
  results.
- `playground-daemon-execution-checks.json` contains process start/end,
  unchanged observer runtime/harness hashes and shutdown checks.
- `playground-daemon-offline-checks.json` contains all 178 receipt joins,
  per-run first-node timings, full-count and revision checks, hashes and limits.
  `playground-daemon-offline-audit.py` retains the exact supplemental audit.

# Runtime sources and timing limits

Both starts captured the same full-path-string-sorted runtime digest before
spawn and after readiness:
`2426018094292a56032eb3a9f5d44c42844e1ad275187755e534ba042e746934`.
Recomputing that digest at the end matched all four captures. The observer's
before/after digest `21d9f556...a780575` is also unchanged, but uses Python
path-component ordering rather than the harness's full path string ordering.
The two formats are distinct and are not compared as if they were identical.
All 14 daemon harness file hashes were unchanged across execution. The root's
separate 467-file freeze remains supplied context, not a reconstructed manifest
from this lane.

All 45 first-node timestamps were present. Creation-to-first-node delay was 1–9 ms, median 1 ms and p95 5 ms, compared with the prior reported 4,791–4,997 ms range. This measures activation latency, not execution throughput.

Admission HTTP latency was median 1.88 ms, p95 7.21 ms and maximum 13.30 ms.
Observed completion was median 820 ms and p95 12420 ms. Server lifecycle was
median 670 ms and p95 12371 ms. These include the intended approval holds where
applicable. Observed completion also includes 200 ms polling and capture costs.
The first-node distribution uses committed run creation and stored node start
timestamps, not actual worker dispatch or effect start. The prior delay numbers
come from the retained prior report; its old database and state were not opened.
No query timing tests or hardware throughput claims were made.

Scripts and fixtures were read-only. This lane changed only its assigned note
and daemon supplemental evidence, plus fresh preparation state created by the
authorized harness. No old state, personal home, personal credentials, foreign service,
Docker resource, cloud preflight, main branch, commit or full check was touched.
