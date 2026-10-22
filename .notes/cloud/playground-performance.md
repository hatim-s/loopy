# Playground performance

API and offline SQL measurement are complete. All 525 primary runs finished with their expected outcomes. The standard route cycle and matched probes passed. A separate bounded pagination probe found a variable-limit failure at 100 and 200 runs per page, and the parent's subsequent fix passed actual Workerd verification on the same 528 retained IDs. The source of the load-associated HTTP tails remains unproved. No index change is justified by this exercise.

## Scope and workload

Only the isolated local playground stack is measured. API 15070, dashboard 15072, sandbox 15071 and inspector 15073 belong to this exercise. Existing services, the shared Colima VM, credentials, personal Loopy state and production source are outside this work.

The planned primary workload is 525 real API-created runs across 15 loopies in three concurrent cohorts. Thirteen loopies receive 25 runs and two receive 100. The driver limits API requests to four slots and the local provider wrapper limits active attempts to four. Run concurrency alone does not bound attempts inside parallel graph nodes. These controls must accompany any throughput number. Admission, expected failures and held approvals belong to the cohort journals; the sampler never launches runs or resolves approvals.

The historical audit found 22 retained runs in other local stacks, 18 succeeded, two failed and two suspended. Those are excluded from the new stack's primary workload. Ephemeral unit tests and direct executor attempts are also excluded.

## API measurements

`bun --no-env-file scripts/playground/metrics.ts PHASE SECONDS RPS` reads the private driver configuration through `PlaygroundClient`. The allowed sampling rate is one to three requests per second, sequentially. Slow requests do not create a catch-up burst. The phase must be new so evidence cannot silently replace an earlier measurement.

The sampler cycles through latest runs, waiting and failed filters, slug filtering, descending run pagination, loopy counts, overview counts, logs, log text filtering, events, run entity filtering, feed pagination, daemon status, run snapshots, run payloads and execution pages/details. Run-dependent probes are skipped on an empty database. Every JSON response is parsed through the existing route schema. Evidence stores statuses, response bytes, item counts, feed scanned counts and pagination state. It never stores payload contents, hook tokens or credentials.

Current measurements are client-observed end-to-end latency. Timing begins before `PlaygroundClient.request` acquires the filesystem API semaphore. It therefore includes API-slot queue wait and its 40 ms polling, HTTP work, and the full response body buffering now performed inside the shared client. `headersMs` is a historical field name, not TTFB. `totalMs` adds consumption of the client's returned buffered response. Response schema parsing is timed separately. These samples cannot independently establish server API latency, SQL query slowness or server queue time. The backend attempt semaphore is a different queue and its measured wait does not identify API-slot wait.

Each endpoint reports nearest-rank p50, p95, p99 and maximum, sample count, statuses and failures. Low sample counts make p99 equal to the maximum and do not support tail-latency confidence. The sampler source is preserved during the active cohort segment. To distinguish API client queue from HTTP work, a separate short segment must use either shared-client instrumentation or a bounded direct read-only request with a declared boundary and matched endpoint/data. It must retain the current evidence rather than overwrite it.

Host CPU count, memory, load and disk context are recorded with bounded process snapshots of the owned supervisor and descendants. `ps` CPU is lifetime averaged, RSS is KiB and descendant discovery is capped at three generations. Docker guest and container CPU are not measured by these host process snapshots. The host also carries unrelated work.

## Copied SQL measurements

The first approved SQLite online backup attempt used a Python connection opened with `mode=ro`. It failed before copying rows with `unable to open database file`. Read-only query attempts through that connection failed too. It did not use a writable connection or copy active WAL files.

The parent then approved a Bun SQLite serialization attempt inside a short explicit deferred read transaction, with bytes written only after the source connection closes. It would verify source/snapshot row counts, selected run IDs and snapshot integrity before analysis. This attempt also failed safely, at the first schema read inside the transaction, with `SQLITE_CANTOPEN`. The failed live-copy paths were removed from the final scripts. No immutable read, FFI workaround or writable live connection was used. The parent subsequently supplied a validated quiesced copy as described below.

Final cloud diagnostics use only the exact parent-approved `standalone/diagnostic.sqlite` below `.loopy/playground/diagnostics/`. Evidence distinguishes the failed serialization attempt from the driver's successful `sqlite3_backup` and standalone-copy procedure.

The final probe opens only the approved diagnostic copy with Bun SQLite in read-only mode. Its `SqlDriver` rejects writes and `exec`. It executes exact source-derived SQL using the production projection and pending-hook constants, recording SQL, query plan, parameter count, returned row count and query time. It does not construct `SqlRunStore` or perform initialization or migrations. No row payloads or parameter values enter evidence. No indexes, schema, statistics or persisted pragmas are changed. Run IDs/statuses are independently matched against the saved API inventory.

Ten repetitions per operation measure local warm-cache behavior. They do not measure Cloudflare SQLite execution or establish production p99. First operation timing includes the probe's initial `EXPLAIN`; raw SQL duration excludes it. Schema, indexes, SQLite version, selected pragmas, table counts and file identity accompany each snapshot result.

Lifecycle queries separately report journal admission latency, queue-to-first-claim latency, queue-to-first-node latency, completed wait duration and terminal wall time. Terminal wall time includes queues, execution, scheduler polling and approval holds. First-node time includes control nodes; node attempt duration is not isolated provider CPU time. Missing claimed events yield null. Primary identity comes from journal run IDs, with retained non-primary runs reported separately.

## Source mechanisms to verify against the workload

- `packages/loopy/src/store/sqlite/query-runs.ts` uses descending `(created_at,id)` run pagination and correlated pending-hook lookups. Counts group by run status using the same run filters.
- `packages/loopy/src/store/sqlite/query-feeds.ts` constrains SQL by numeric cursor and optional run ID, then applies several other filters in application code over a bounded candidate scan. A small filtered result can still require scanning many candidates. Record `scanned` and `hasMore` before judging this behavior.
- `packages/loopy/src/service/service.ts` builds each loopy view from a per-loopy count query and latest run query. Measure the full `/loopies` response as well as component SQL operations.
- `apps/cloud/src/workspace.ts` serializes requests and scheduler alarms per workspace. API wait time can include scheduler work even when individual SQL statements are fast.
- `apps/cloud/src/scheduler.ts` separately selects running and ready work, counts running runs and computes the next alarm. The production store's `dueRuns` method is not the cloud scheduler's candidate query.

## Evidence and validation

The authenticated empty baseline ran from `2026-10-22T19:55:13.005Z` to `19:56:43.866Z`. It recorded 140 samples across 14 endpoint variants, ten each, all HTTP 200 with no transport or schema failures. Per-endpoint medians ranged from 3.06 to 4.16 ms. The largest observed response took 8.78 ms. With ten samples each, p95 and p99 equal the maximum and have little tail-confidence value. Run-dependent probes were skipped because the database was empty. Evidence is `evidence/playground-performance-baseline-empty.json`.

All three preflight receipts then passed with one succeeded run per cohort. The small-data baseline started after the last terminal receipt at `2026-10-22T19:59:28.002Z`. It completed 180 requests across 18 variants, ten each, all HTTP 200 without schema or transport failures. It observed 15 loopies and three runs. `/loopies` median was 20.04 ms for 10,346 bytes. Run snapshot median was 18.80 ms, and its 31.94 ms maximum was the largest response in this phase. The empty and small baselines have little tail-confidence value. Evidence is `evidence/playground-performance-baseline-small.json`.

The journal-only baseline separates all three preflights from primary workload. Their median admission was 27 ms and maximum 33 ms. One preflight held an approval for 10,337 ms after runner observation; that planned hold accounts for most of its 12,033 ms terminal wall time. These are lifecycle wall times, not provider CPU measurements. Evidence is `evidence/playground-performance-baseline-small-lifecycle.json`.

The continuous sampler started before the primary launch gate. It preserved a 186.58 ms failed-status-list response observed while the last loopy count still showed only three preflights. This outlier is pre-admission context, not evidence of load causation. The parent authorized a driver-owned stack refresh before mass load. The sampler captured 92 transport failures from `20:05:46.085Z` through `20:06:31.645Z`, followed by successful HTTP 200 responses. Restart samples remain outside the launch-aligned workload interval.

The root dispatched all three primary cohorts at `2026-10-22T20:14:07Z`. The first measured primary intent was `20:14:11.628Z`, admitted at `20:14:11.649Z`. The initial 119 launch-aligned samples had zero failures, median 31.52 ms, p95 688.43 ms, p99 1,120.37 ms and maximum 1,511.12 ms. These are aggregate client-observed end-to-end times across endpoint variants, including API-slot queueing. They are not server latency or evidence of SQL contention. At the same progress capture, 275 completed backend starts had median backend duration 355 ms and p95 508 ms; backend queue p95 was 177 ms. The latest pressure guard sample passed but sampled zero running container bytes at one instant, which does not establish zero peak memory.

No workload is launched by the performance scripts. Full load and post-load results will be added after collection.

## Matched transport segment under load

The parent authorized a separate read-only matched probe without changing PID 47144 or the shared client. `bun --no-env-file scripts/playground/metrics-matched.ts matched-load` made 36 requests from `2026-10-22T20:17:48.652Z` through `20:18:26.714Z`. Six pairs per route used `/runs?limit=50`, `/loopies` and `/event-history?limit=50`, alternating direct/shared order. Requests were sequential at no more than one per second. Direct bypass added at most one concurrent HTTP request beyond the shared four-slot pool. All responses passed status and route-schema checks. Evidence is `evidence/playground-performance-matched-load.json`.

Direct HTTP/body-read maxima were 594.04 ms for runs, 621.04 ms for loopies and 561.48 ms for events. Shared-client maxima were 1,536.67 ms, 994.76 ms and 2,530.02 ms. The medians were mixed: direct/shared run medians were 79.85/17.50 ms, loopy medians 114.64/199.97 ms and event medians 114.13/8.91 ms. These six-sample comparisons do not establish confidence or an exact API-slot penalty. Retained run counts changed from 265 to 276 during the loopy pairs, so pair data is close in time but not identical.

Direct fetch timestamps headers before consuming the body, then measures body completion and schema parsing separately. Its delays include local transport, HTTP and server scheduling. Direct delays demonstrate that shared-client API-slot queueing does not explain every slow response, but cannot identify SQL time. The unchanged shared client buffers before the probe sees its response, so its internal allocation is outside the probe's 8 MiB reader cap. Each route response was far below that cap and every request had a 15-second abort signal.

Only the new matched file received scoped ESLint and Biome checks during this segment. No broad checks, existing sampler/client edits, runtime edits or workflow mutations ran through this probe.

## Completed workload and controlled post-load capture

The primary journal interval runs from first intent `2026-10-22T20:14:11.628Z` through last durable terminal timestamp `20:25:46.961Z`. Group A's final durable terminal time was `20:20:40.836Z`, B's was `20:20:48.892Z` and C's was `20:25:46.961Z`. Driver summaries finish later because they collect artifacts and write receipts after terminal state. All 525 primary records reached terminal state: 461 succeeded, 64 failed as controlled inputs expected, and none had an unexpected outcome. Three succeeded preflights are separate, yielding 528 retained runs, 464 succeeded and 64 failed. All 525 primary IDs and expected statuses match the paginated API inventory. No active or waiting runs remain in that inventory.

The original continuous sampler exited with code 0 after SIGTERM and saved its final file at `20:27:45.295Z`. Its 2,811 total samples include the preserved pre-load/restart intervals and post-terminal browser verification. The actual primary interval contains 1,201 client-observed samples with no failures: median 16.35 ms, p95 886.79 ms, p99 2,150.67 ms and maximum 5,436.64 ms. These aggregates mix endpoints and include API-slot queueing. The segment file also provides per-endpoint distributions and request counts. The first cohort transition interval contains 603 samples with p95 1,242.58 ms; after B finished, the C-only tail contains 591 samples with p95 328.01 ms. The narrow A-to-B transition contains only seven samples and supports no tail claim. These comparisons have different workload mixes and do not isolate a cause.

The controlled post-load sampler ran from `20:27:45.473Z` through `20:29:16.012Z`, 180 requests across the same 18 variants with no failures. Its largest response took 34.49 ms. Median `/loopies` latency was 19.96 ms for 121,826 bytes, compared with small-data baseline 20.04 ms for 10,346 bytes. The populated run list, filters, pagination, logs, events, run payload and execution endpoints all passed their existing response schemas. Ten observations per endpoint still provide little tail confidence.

The identical matched post-load probe ran from `20:29:40.141Z` through `20:30:16.123Z`, 36 requests with no failures. Direct runs/loopies/events medians were 13.55/18.60/8.85 ms and maxima 20.39/32.28/12.34 ms. Shared-client medians were 15.24/22.58/10.58 ms and maxima 34.50/27.09/12.35 ms. Data stayed at 528 retained runs. The difference from active-load direct maxima supports load-associated HTTP/local transport/server scheduling delay. It does not locate SQL cost, and the active and completed datasets differ.

Primary admission wall time had median 111 ms, p95 1,159 ms, p99 2,257 ms and maximum 5,213 ms. Terminal wall time from admission had median 2,956 ms, p95 40,565 ms and maximum 50,346 ms. The 125 observed approval holds had median 28,947 ms and maximum 48,633 ms. Those intentional waits explain why the terminal distribution cannot represent execution service time.

The runtime log contains 1,552 completed primary provider starts, separate from workflow counts. Backend duration had median 384 ms, p95 564 ms, p99 739 ms and maximum 1,032 ms. The separate backend semaphore wait had median 0 ms, p95 254 ms, p99 461 ms and maximum 614 ms. Outcomes were 1,511 succeeded provider starts and 41 execution failures; these are not the 461/64 workflow outcome counts because control nodes can fail without starting a provider. No uncertain or transport-exception outcomes appeared. Host process context includes 67 sampled observations during the primary interval; container CPU/memory peaks remain unmeasured by that host data.

Evidence files are `playground-performance-segments.json`, `playground-performance-primary-final-lifecycle.json`, `playground-performance-runtime.json`, `playground-performance-postload.json`, `playground-performance-matched-postload.json` and `playground-performance-postload-inventory.json` under `evidence/`.

## Pagination failure and verified fix

After the controlled captures, `/runs?limit=200` returned HTTP 500 with the contract error code `internal` twice. A bounded boundary check found 99 selected rows returns HTTP 200, while 100 returns HTTP 500. The 50-row API inventory then traversed all 528 records without duplicates, missing primary IDs or status mismatches. These separate diagnostic failures are preserved in `evidence/playground-performance-page-limit.json`; they are not omitted from the report because the standard 50-row cycle passed.

`packages/loopy/src/service/service.ts:274` passes every selected run ID to `pendingHooks`. `packages/loopy/src/store/sqlite/query-runs.ts:148` builds a dynamic `IN` binding per selected ID and adds one binding for time at line 150. The observed 99/100 boundary strongly implicates the runtime parameter limit, although the cloud error boundary hides the underlying SQL exception. No SQL query-time or index conclusion follows from this behavior.

The parent's fix passes one JSON array through `json_each(?)`, so the lookup uses two bindings regardless of selected run count. It preserves the public 200-run page contract and all selected runs rather than lowering page size or dropping hooks. After the quiesced snapshot, the driver restarted the same owned local state and verified pages 99/100/200 return HTTP 200 with the requested rows, page 201 returns HTTP 400, and cursor pages 200+200+128 exactly match all 528 IDs/statuses. No runs were added. The verified `query-runs.ts` SHA-256 is `8383ce0afc84e83047397e0606a6fa1ad1ea9950bb1443540c6750d2ee101728`. Evidence is `evidence/playground-driver-pagination-fixed.json`. This performance task made no production edits.

## Quiesced snapshot and native SQL findings

The driver stopped only the owned playground stack and copied the complete closed DO tree, including sidecars. It verified source/raw SHA-256, size and mtime before and after. The performance task never opened the live database, raw tree or working copy. The initial `validated.sqlite` retained a stale SHM after conversion and remains preserved; it is not described as sidecar-free.

The sole final cloud diagnostic source was `.loopy/playground/diagnostics/quiesced-postload-20261022T203547958718Z/standalone/diagnostic.sqlite`, SHA-256 `0d0ce744814caf442edf3c3fde3e74b129019f7602db4bb393a431cd341697fa`. The probe independently confirmed integrity OK, DELETE journal mode, no sidecars before or after, unchanged hash and exact 528-ID/status inventory match. It counted 4,721 node runs, 4,746 attempts, 604 scope records, 2,727 logs, 16,913 events, 126 waits and 528 cloud turns.

The command was `bun --no-env-file scripts/playground/metrics-sql.ts postload-offline .loopy/playground/diagnostics/quiesced-postload-20261022T203547958718Z/standalone/diagnostic.sqlite`. Its artifact pins seven source hashes before/after, stable within the probe, and identifies the loaded source as after the `json_each` pagination edit. It also reconstructs the exact historical dynamic-IN shape on the same copied data. The 50/99/100/200 selected-ID results have matching old/new digests; the 200-ID variant changes from 201 bindings to two. All native variants execute successfully. That is expected on native SQLite and does not reproduce Workerd's variable ceiling. These terminal rows also cannot prove preservation of unresolved hook payloads; the parent's correctness checks own that case.

Measured native warm SQL medians were 0.034 ms for latest runs, 0.061 ms for the waiting filter, 0.012 ms for all-status counts, 1.269 ms for the 2,001-row log candidate scan, 1.395 ms for the text-match candidate scan and 0.835 ms for the 2,001-row event candidate scan. These are ten repetitions on a shared host, not production p99 or a controlled hardware benchmark. The SQL artifact was written at `20:41:25.439Z`, after the daemon interval ended at `20:41:07.823Z`; an earlier concurrent-daemon label was corrected in the artifact without changing its timing values. Host activity was not isolated. Result conversion into views and application-side feed filtering are outside these SQL durations.

Plans use `runs_created_id` for latest runs, `waits_run` and the node-run primary key for correlated waits, integer primary-key range seeks for logs/events with run-primary-key joins, and `node_runs_scope` for execution pages. The ready-work query uses a multi-index OR over `runs_due` and a temporary B-tree for ordering. It returns zero rows in this terminal snapshot and takes about 0.005 ms median here. The temporary sort alone does not justify a new index or explain active-work scheduler cost. The largest observed SQL work was bounded candidate retrieval for feeds, about 2,001 rows even when the API asks for 50 matching records. Its mechanism is worth retaining in performance evidence, but measured cost and plans do not support an index change for this dataset.

The copied durable records add queue-to-first-claim measurements for all 525 primary runs: median 31 ms, p95 2,222 ms, p99 3,140 ms and maximum 3,845 ms. This interval is from run creation inside the service, so it excludes client admission queueing. First-node timestamps happen to have the same distribution for this workload. Claim-to-terminal wall time has median 2,486 ms and p95 40,520 ms and still includes execution, polling and approval holds. The 126 durable completed waits include the separate preflight hold, unlike the primary-only journal's 125 holds.

Evidence is `evidence/playground-performance-postload-offline-sql.json`. It preserves every SQL statement, plan, count, digest, source hash and timing limit. The live HTTP tails remain unproved beyond observed client queueing and direct HTTP-path delay. This native snapshot does not isolate live scheduler serialization, runtime work, JSON processing or local transport as the cause.

## Separate daemon comparison

The daemon owner completed 45 serial workflows, 39 succeeded and six controlled failures, with nine holds of 10,003–12,005 ms. It stopped its owned daemon and supplied `.loopy/playground-daemon/daemon-readonly.sqlite`. This task opened only that backup, never the live home database, and made no daemon API calls or restarts.

`bun --no-env-file scripts/playground/metrics-daemon-sql.ts` independently matched all 45 API IDs/statuses and verified integrity OK, DELETE mode and unchanged SHA-256 `5f83e877a93e335e4f5ac5d1586c5dea9db6523bf9de9614dd8c377774297771`. Counts were 457 node runs, 466 attempts, 72 scope records, 400 logs, 1,321 events and nine waits. It recorded source-derived run/count/feed/execution plans, without query timings because the parent's full check was running concurrently. The actual daemon uses host Bun/SQLite and sandbox-exec, with one active workflow and 200 ms active-run polling. The cloud stack uses Workerd DO SQL and Docker with a separate four-attempt limit. Their workload and hardware paths differ, so these records establish behavior and recovery coverage, not a controlled latency comparison. Evidence is `evidence/playground-performance-daemon-offline-sql.json`; the daemon owner supplies semantic output/recovery proof.

## Final validation and remaining limits

All owned metrics scripts pass scoped ESLint, Biome and strict TypeScript checks. No tests were added, moved or deleted. The parent owns the full repository check and independent review. No commits were made by this task. API timing evidence is complete; no new workflow launches, source/runtime mutations or live API calls are required from the performance task.

The diagnostics add 1,997 TypeScript lines across 16 new files and remove zero existing tracked code lines. This includes the post-capture typed-reader correction below. Production behavior changed only through the parent's separately owned pagination fix. The scripts add bounded read-only sampling, journal analysis, identity inventory and copied-database diagnostics; they do not launch workflows or resolve approvals.

The exact final scoped commands were:

```text
bunx biome check --write scripts/playground/metrics*.ts
bunx eslint --fix scripts/playground/metrics*.ts
bunx biome check scripts/playground/metrics*.ts
bunx tsc --noEmit --target ES2022 --module ESNext --moduleResolution Bundler --strict --noUncheckedIndexedAccess --skipLibCheck --types bun-types scripts/playground/metrics*.ts
```

Final results were ESLint exit 0 with no output, Biome checked 16 files with no fixes needed, and TypeScript exit 0 with no output. Full-check output is parent-owned. No index change, scheduler fix or source-of-HTTP-tail claim follows from these diagnostics.

## Post-capture typed-reader correction

The parent's actual repository typecheck found TS2504 in `metrics-request.ts`: the configured `ES2022`, `DOM` and `DOM.Iterable` libraries do not declare `ReadableStream` async iteration. The earlier file-scoped TypeScript command used compiler library defaults and did not validate that exact repository configuration. All historical captures used the earlier `for await` reader. Those timings, bytes, failures and source provenance remain unchanged.

After capture, only `metrics-request.ts` changed to `getReader()` and a typed `read()` loop, following `apps/cloud/src/http.ts`. It retains the 8 MiB byte boundary, explicitly cancels an oversized stream and releases the lock in `finally`. No casts or global DOM library changes were added. The correction adds 13 net lines to the tooling; no remeasurement, API requests or database access occurred. The corrected file SHA-256 is `221bbc2300d252bd945ff0e737a081f830a3f5d13b0b514d6dd747a3aa82c9e1`.

`bunx eslint scripts/playground/metrics-request.ts` passed with no output. `bunx biome check scripts/playground/metrics-request.ts` checked one file and needed no fixes. The requested actual `bun run typecheck` ran `tsc --noEmit` under the repository configuration and reported no TS2504 or metrics-file error. It exited 2 on the separately owned `packages/loopy/_tests_/fixtures/daemon-wake-smoke.ts:96:54`, TS18048, because `record` is possibly undefined. That prevents the command's subsequent portable typecheck from running. The parent owns that remaining gate; this task did not edit its fixture.

The continuous sampler accepts up to 3,600 seconds and prints its PID, phase-scoped output, progress after each endpoint cycle and an exact `kill -TERM PID` stop command. SIGTERM stops after the current bounded request and saves the final JSON evidence. Sampling has no request overlap or catch-up burst.

Scoped validation before baseline:

```text
bunx biome check --write scripts/playground/metrics*.ts
Checked 8 files. Formatting applied.

bunx eslint --fix scripts/playground/metrics*.ts
Passed after resolving reported rules.

bunx tsc --noEmit --target ES2022 --module ESNext --moduleResolution Bundler --strict --noUncheckedIndexedAccess --skipLibCheck --types bun-types scripts/playground/metrics*.ts
Passed with no output.
```

The parent owns full checks and independent review. No commits were created by this task. One read-only source research child ran as `codex/gpt-6-luna`, reasoning effort medium, service tier default. Task ID `node:delegated-task:command%3Amcp%3A0031baa7-ce84-40c3-a6fb-b250b153f819%3Adelegate-task%3Aplayground-performance-sql-luna-01` completed. It made no edits, database calls or workload launches.
