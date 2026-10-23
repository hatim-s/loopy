# Architecture repeat cohorts

Status: passed. All 525 primary runs completed with the expected outcomes. All three original sessions exited 0. All 461 retained exports, complete scoped node and attempt census, 125 approval histories and 2,713 primary log records passed semantic validation.

## Authorization and source identity

The root opened `ROOTPRIMARYGATE` for batch `playground-architecture-2026-10-23T15-18-37-705Z` after preparing 15 frozen fixtures, passing three separate preflights, accepting the small baseline and arming the driver. The root's continuous sampler was PID 46381, session 90588. This lane did not start or control that sampler.

Checkout is `/Users/hatim.shakir/projects/loopy/cloud-integration`, branch `cloud-integration`, HEAD `6ffecdfd60e16aaa335467684d918b3cd8b44813`. The root's 467-file source freeze has aggregate SHA-256 `93e0bcd0fccac0dbf8deff30aa0eb9e4b18ec15cac090c2ec6d8cb00ae8edc52`. Its retained manifest is `.notes/cloud/evidence/architecture/source-freeze.json`, file SHA-256 `34369d678d2d9baf06841c5309e066c2e0b6aacf0d934d03c922d98bf73d682c` at launch. Independent post-run comparison verified all 467 individual file hashes and the unchanged manifest file hash. The aggregate above is the root's recorded identity. An initial local aggregate assertion used an assumed serialization and failed despite all individual hashes matching. The corrected check compares the exact retained manifest and every source file; it does not claim to reproduce the root's aggregate serialization.

The prepared fixture receipt records source hash `a213d51dab78b89a140ebcc1c792daa18558d9fb428330bdc21b650400de9c89`, seed commit `95d1e5b4769f149c98692cc41897e09a80da8741` and 15 graph revisions. The selected architecture image digest in the root's freeze is `sha256:ffc247b1e3a93dc0eafb8f387ed52d5b8fc7445e929a701f2117f6a0cc175722`. These are retained preparation identities, not a separate image inspection by this lane.

## Single concurrent launch

Dispatch was `2026-10-23 15:35:21 UTC`. Each group received exactly one invocation, concurrently:

```sh
env LOOPY_PLAYGROUND_PROFILE=architecture bun --no-env-file scripts/playground/index.ts cohort --group a
env LOOPY_PLAYGROUND_PROFILE=architecture bun --no-env-file scripts/playground/index.ts cohort --group b
env LOOPY_PLAYGROUND_PROFILE=architecture bun --no-env-file scripts/playground/index.ts cohort --group c
```

| Group | Terminal session | Driver PID | Durable lock timestamp | First journal admission | First run ID | Exit |
| --- | ---: | ---: | --- | --- | --- | --- |
| A | 71988 | 50217 | 2026-10-23T15:35:22.076Z | 2026-10-23T15:35:22.418Z | 97acfe1f-afbf-42a0-bf0f-13865ab8c5f5 | 0 |
| B | 11219 | 50213 | 2026-10-23T15:35:21.864Z | 2026-10-23T15:35:22.363Z | 8889fd05-1658-41c8-bca7-5819190c17f7 | 0 |
| C | 61089 | 50216 | 2026-10-23T15:35:22.121Z | 2026-10-23T15:35:22.451Z | af519d4d-1822-466c-a1fb-11942e7654d5 | 0 |

All three OS process observations showed the exact group command and local start `Fri Oct 23 21:05:21 2026`, UTC+05:30. Lock files persist under `.loopy/playground-architecture/cohorts/primary-<group>.lock`.

## Required outcomes and semantic checks

The actual primary totals match the requested distribution. B's separate node-level requirement is all 25 retry nodes at attempt two, including four controlled final failures.

| Group | Runs | Successes | Controlled failures | Approvals | Driver start | Driver end | Elapsed ms |
| --- | ---: | ---: | ---: | ---: | --- | --- | ---: |
| A | 200 | 172 | 28 | 25 | 2026-10-23T15:35:22.089Z | 2026-10-23T15:45:24.277Z | 602188 |
| B | 200 | 172 | 28 | 25 | 2026-10-23T15:35:21.878Z | 2026-10-23T15:45:52.316Z | 630438 |
| C | 125 | 117 | 8 | 75 | 2026-10-23T15:35:22.131Z | 2026-10-23T15:49:20.039Z | 837908 |
| Total | 525 | 461 | 64 | 125 | | | |

The last primary driver boundary was `2026-10-23T15:49:20.039Z`. Root was notified promptly so it could trigger postcapture measurements. There are 525 unique primary run IDs. Each has exactly one admission, terminal and artifact event. Each approval run has exactly one observed wait, approval intent and resolution event. No ambiguous request was repeated.

The inline `python3 -` offline validator derives expected objects from journaled inputs without importing fixture functions. It checked all 461 exported objects' complete contents, batch, ordinal, slug, byte length, SHA-256 and exact destination. It checked all 64 controlled failures against their owning markers and confirmed no failed-run host export. It also checked every ordinal, exact per-workflow result directory census, driver/progress equality and delayed approval timestamps. The final run printed 200/172/28 for A, 200/172/28 for B and 125/117/8 for C, with all artifact semantics passing. Maximum artifact sizes were 489, 185 and 400 bytes respectively.

The configured approval delay is 10 to 45 seconds. Observed holds include polling, guard and API resolution time. Every resolution occurred at or after its own recorded due time.

| Group | Observed minimum ms | Observed median ms | Observed maximum ms | Holds above 45000 ms | Maximum due overshoot ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| A | 11028 | 32613 | 47197 | 2 | 13748 |
| B | 11021 | 31826 | 48997 | 2 | 8552 |
| C | 10386 | 28998 | 47208 | 9 | 12566 |

These observations do not establish a hard 45-second upper bound.

Retained evidence is `.notes/cloud/evidence/architecture/playground-driver-primary-<group>.json` and `playground-cohort-<group>-semantics.json`. The three semantic files retain every primary run ID, complete journaled input, terminal error, progress result, exact expected and actual export object, export digest and approval timing. Admissions, progress files and event journals remain under `.loopy/playground-architecture/journal/`. Exports remain under `.loopy/playground-architecture/loopies-playground/results/<batch>/<slug>/<runId>.json`.

Node-level map, parallel, retry, sleep and complete scoped execution checks passed against the root's verified standalone stopped Workspace database. No additional HTTP request was made by this lane during load.

## Pinned graph evidence

After root declared metrics API measurement done at `2026-10-23T15:53:42.548Z`, it authorized 15 representative pinned graph reads through the existing authenticated shared client. The initial local validator checked `graph.slug`, but the contract field is `graph.name`. That first GET completed, then local validation failed before the response was saved. Root expressly authorized one replacement read, increasing the maximum to 16 GETs. No admission or approval request was repeated.

The corrected round retained all 15 response bodies before semantic checks, then validated them with the actual route schema, selected primary admission identity, batch, graph name and frozen revision. Every retained body also has its byte length, SHA-256, request and completion timestamp. Reads were sequential, with at least one second between request starts, a 15-second deadline per request and a 512 KiB body cap. Actual bodies were 1,724 to 4,138 bytes. The corrected graph-read session was `88621` and exited 0.

Exactly 16 graph GETs occurred in total. There were no node API reads. Graph evidence is inside the three owned semantic JSON files. Root was notified when graph reads completed. This lane made no further HTTP requests.

## Complete persisted semantic census

Root authorized only this standalone Workspace file for immutable read-only SQLite access:

```text
.loopy/playground-architecture/diagnostics/closed-snapshot-20261023T160158250238Z/standalone/loopy-playground-architecture-local-Workspace/c9fc980e43ecc368c89f7bc55f965f1da91aa94aa0bd54dd7515a5a571209ad3.sqlite
```

Its SHA-256 is `05ac0b40f0c0bbcfd69f8e04a470324a6d6c5632256d099e89e9ae8388d213d4`. Both validation passes checked that digest before opening and after closing. It remained unchanged. No Store constructor, migration, source database, raw snapshot or live database was opened. Root established the stopped standalone copy's provenance and integrity. The copy contains 528 runs, consisting of 525 primary runs and three separate preflights. Complete semantic checks below cover the 525 primary IDs.

| Group | Persisted nodes | Scoped nodes | Executable nodes | Executable attempts | Maps / children | Parallels / children | Sleeps | Approved waits |
| --- | ---: | ---: | ---: | ---: | --- | --- | ---: | ---: |
| A | 1916 | 200 | 547 | 547 | 50 / 100 | 25 / 50 | 25 | 25 |
| B | 1862 | 400 | 630 | 655 | 100 / 200 | 25 / 50 | 0 | 25 |
| C | 917 | 0 | 350 | 350 | 0 / 0 | 25 / 75 | 25 | 75 |
| Total | 4695 | 600 | 1527 | 1552 | 150 / 300 | 75 / 175 | 50 | 125 |

Every database run's input, workspace, slug, revision and outcome matched its admission and pinned graph. Every persisted node belongs to that graph. Every expected executable node is present with the correct scope, terminal status, attempt limit and finished receipt. Its latest attempt history record equals its current node record. The 25 B retry nodes all have attempts one and two. Attempt one retains the controlled failure and a finished receipt. Attempt two produced 21 successes and four controlled final failures.

The complete attempt table contains 4,720 primary node attempts, including built-in nodes. Counts are A 1,916, B 1,887 and C 917. Every attempt belongs to a current persisted execution key, each key has exactly attempts one through its current attempt, and every latest record equals the current node record. All 4,695 current nodes are terminal, with 4,583 succeeded and 112 failed records. Every persisted run output also matches its pinned graph output reference over the validated node outputs, or is null for a failed run.

The 64 failed runs have 112 failed node records. The 48 DSL failures persist both the intended fail node and its enclosing failed branch. The other 16 failures occur in code nodes. All failed records have execution error codes and match their run's exact persisted error message. These are expected control propagation records, not additional failed runs.

All 150 maps retained their ordered outputs, all 300 child outputs matched their individual items and indices, and all child execution keys carried the exact ordered map scope. All 75 parallel nodes and 175 branch outputs matched independent expected values, including branches completed before an intended later failure. Every one of the 600 `node_scopes` membership rows exactly matched its node execution key, scope prefix, item index and status. These represent 300 map items. The scoped census uses full SQL records and does not extrapolate from root-only API pages.

All 50 sleep nodes completed after their pinned requested durations, 200 ms in A and two seconds in C. Persisted timestamps are retained. This is not a complete scheduling latency measurement. All 125 wait node outputs and durable hook histories contain `approved: true`, have a resolution timestamp and have no expiry. Hook tokens are omitted from semantic evidence.

Semantic examples use ordinal zero's items `[1, 2]`:

- A lint map produced `[{check: 1, findings: 1}, {check: 2, findings: 1}]`; generated docs preserved the same item order and their respective seeded TypeScript declarations. Dependency parallel outputs retained inventory count two and review count one.
- B test matrix produced scores `[3, 7]`. Parallel builds produced client/server sizes `[38, 47]`. The successful retry produced `[2, 3]` on attempt two. Release values matched seeded inputs, and audit values were numerically sorted with the exact `12 + ordinal % 9` record count.
- C retained exact seed CSV hashes, migration-column hashes, policy/source hashes, resumed totals and four-file manifest hashes. Repository validation checked all three file names, byte counts and hashes for every run, including the four intended final-report failures.

The node validator's final output was `status: passed`, with 4,695 nodes, 1,527 executable nodes, 1,552 executable attempts, 150 maps, 300 map children, 75 parallels, 175 parallel children, 50 sleeps, 125 approved waits and 25 retry nodes at attempt two.

## Scope and log projection checks

| Group | Scope membership rows | Map items | Log records | Expected stderr records | Other logs with exact semantic data |
| --- | ---: | ---: | ---: | ---: | ---: |
| A | 200 | 100 | 999 | 0 | 999 |
| B | 400 | 200 | 1131 | 33 | 1098 |
| C | 0 | 0 | 583 | 8 | 575 |
| Total | 600 | 300 | 2713 | 41 | 2672 |

Every log record's run, execution key, attempt, node ID, sequence and per-attempt index matched its normalized SQL columns and persisted node attempt. Run sequences and per-attempt indices were contiguous, with no missing or duplicate identity. Every non-stderr message and its complete data matched the fixture's independently expected logs or the pinned DSL log expression over already-validated inputs and outputs. This includes all 393 B audit records and both marker logs for each retry.

The 41 stderr records correspond exactly to 29 failed retry attempts, four audit failures and eight C report failures. Each has the expected controlled marker, stays within the byte bound and retains a data digest. Stack-trace formatting is not recomputed. The scope/log validator printed `status: passed`, 600 membership rows, 300 map items, 2,713 logs and an unchanged database hash.

## Proof limits and retained changes

This is actual local Wrangler and Docker workload evidence. The semantic checks establish the retained outcomes, artifacts, node outputs, attempts, waits, scope projections and log consistency for these finite runs. Persisted attempt identity alone does not prove a worker executed an arbitrary external effect exactly once. Receipt DO/R2 authority verification, physical worker identity, performance attribution, failure exercises and final integration belong to root's separate evidence.

The authored files are this report and the three architecture `playground-cohort-<group>-semantics.json` files. Each semantic file includes every primary run ID, export and expected object, all persisted execution keys, relevant node records, retry attempt history, sanitized approval history, exact scope memberships, all primary logs and the representative raw pinned graph responses. No tests were added, deleted or moved. No production, harness or fixture source behavior changed. No broad check was run by this lane.

## Scope

This lane owns this report and `.notes/cloud/evidence/architecture/playground-cohort-*-semantics.json` only. Existing scripts and fixtures are read-only. There has been no rerun, recovery, ABORT clearing, manual run or approval submission, service operation, source edit, broad check, commit, remote provisioning, main operation or delegated child task. The existing driver performs admissions and approvals. Old state is untouched. The root owns stack cleanup and performance capture.
