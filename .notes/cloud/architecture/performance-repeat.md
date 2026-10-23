---
title: Architecture workload performance repeat
status: completed in performance lane
date: 2026-10-23
starting-head: 6ffecdfd60e16aaa335467684d918b3cd8b44813
---

# Result

All authorized HTTP captures and the 528-ID inventory are complete. Every observed request passed, and all primary IDs have expected outcomes. Quiescent metadata medians improved against the historical capture, while active-load HTTP tails and backend durations were higher. SQL and architecture causation remain unproved. Approved closed-copy cloud SQL and stopped-daemon diagnostics also passed, with unchanged approved hashes and complete API identity matches. Native SQL does not isolate the active HTTP delays.

# Preparation

Prepared at 2026-10-23T15:15:50.527Z on branch cloud-integration. No sampler, API request, port check or database probe has run. Root owns stack launch, fixture preparation, preflights, arming, workload admissions, service shutdown and closed-copy approval. This lane owns only this report and new performance evidence under .notes/cloud/evidence/architecture. Existing metrics scripts remain unchanged.

The exact capture order is empty 90 seconds at two requests per second before preparation, small-data 90 seconds at two requests per second after three terminal preflights, continuous sampling up to 3,600 seconds at two requests per second, one 36-request matched segment at no more than one request per second under load, graceful stop at the root terminal gate, postload 90 seconds at two requests per second, the identical postload matched segment, then the 528-ID inventory. Raw captures finish before root receipt-collector traffic.

The sampler prints its PID and saves after SIGTERM finishes the current bounded request. This lane will retain its execution session and exact PID, signal only that PID, then verify exit and final evidence. No process-name matching or service signals are authorized. Failed requests and their timestamps stay in raw captures.

Shared-client timing includes filesystem API-slot acquisition, 40 ms polling and HTTP/body buffering. Direct matched measurements include HTTP, local transport, server scheduling and body consumption. Neither isolates SQL. Native copied SQL is distinct from workerd SQL and is not a hardware benchmark. Only the standalone copy and matching current-batch closed-copy manifest supplied after ROOTCLOSED-COPY may authorize SQL diagnostics. No live database, immutable flag, FFI or direct source database access is authorized.

Final comparison will retain actual per-endpoint, per-phase sample counts, HTTP statuses, failures, response bytes and nearest-rank p50/p95/p99. The grouped-count O(N) mechanism and summary warm zero-R2 behavior will be attributed separately to source and unit evidence. They are not measurements supplied by HTTP captures. Historical comparisons may read old evidence JSON and the prior report only. Old private config, runtime state and databases are excluded.

Preparation source hashes are saved in evidence/architecture/performance-repeat-preparation.json relative to .notes/cloud. The first source-hash generation failed because node crypto rejected ArrayBuffer. The corrected preparation uses Uint8Array and preserves the failure in the manifest. No sampler or database probe was involved.

No source edits, tests, admissions, services, commits or delegates were performed by this lane.

# Empty baseline completed

The authorized command ran from 2026-10-23T15:24:47.426Z through 2026-10-23T15:26:18.123Z, with elapsed 90696.45 ms, target two requests per second and no request overlap. Sampler PID 69324 exited 0 naturally. It saved 140 samples across 14 endpoint variants, all HTTP 200 and zero transport, HTTP, body-limit or schema failures. Run-dependent probes were skipped on the empty dataset, leaving ten samples per unconditional endpoint. The 18-step plan still consumes pacing ticks for those skipped probes. No extra API calls were made to validate this capture.

| Endpoint | Samples | Status counts | Failures | Bytes p50/max | Latency p50 ms | p95 ms | p99 ms |
| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: |
| runs.latest | 10 | {"200":10} | 0 | 2/2 | 3.28 | 33.54 | 33.54 |
| loopies.counts | 10 | {"200":10} | 0 | 2/2 | 3.57 | 31.06 | 31.06 |
| runs.waiting | 10 | {"200":10} | 0 | 2/2 | 4.21 | 13.37 | 13.37 |
| runs.failed | 10 | {"200":10} | 0 | 2/2 | 3.66 | 54.42 | 54.42 |
| overview.counts | 10 | {"200":10} | 0 | 3212/3212 | 3.62 | 12.97 | 12.97 |
| logs.latest | 10 | {"200":10} | 0 | 131/131 | 3.68 | 21.11 | 21.11 |
| events.latest | 10 | {"200":10} | 0 | 131/131 | 3.42 | 5.14 | 5.14 |
| daemon | 10 | {"200":10} | 0 | 97/97 | 3.31 | 4.41 | 4.41 |
| runs.page2 | 10 | {"200":10} | 0 | 2/2 | 3.56 | 72.40 | 72.40 |
| runs.slug | 10 | {"200":10} | 0 | 2/2 | 4.16 | 30.33 | 30.33 |
| logs.text | 10 | {"200":10} | 0 | 131/131 | 3.53 | 57.20 | 57.20 |
| events.run-filter | 10 | {"200":10} | 0 | 131/131 | 3.69 | 6.54 | 6.54 |
| logs.page2 | 10 | {"200":10} | 0 | 131/131 | 3.82 | 53.27 | 53.27 |
| events.page2 | 10 | {"200":10} | 0 | 131/131 | 3.63 | 38.84 | 38.84 |

These are shared-client end-to-end times including filesystem API-slot wait and HTTP/body work. With ten observations per endpoint, p95 and p99 equal the observed maximum and do not estimate reliable tails. The previous empty-baseline JSON was read only; its exact endpoint comparisons, counts, statuses, bytes and percentiles are retained alongside current values in performance-repeat-baseline-empty-validation.json. Definition metadata and run counts are empty here, so this phase cannot establish the effect of summary or grouped-count changes.

Raw capture SHA-256 is 3b1986d8e804f4e092c3fe5a16a6c9e3750a438a1baa13b8f84400c8b5157384. All 16 metrics source hashes match preparation: true. Capture and validation evidence are under .notes/cloud/evidence/architecture. Root may now prepare fixtures and run the three preflights. The small-data baseline remains gated on their terminal completion.

# Small-data baseline completed

After root confirmed three succeeded terminal preflights and 15 definitions, the exact baseline-small 90 2 command ran once from 2026-10-23T15:31:42.901Z through 2026-10-23T15:33:13.755Z, elapsed 90849.73 ms. PID 23428 exited 0 naturally. Actual capture contains 178 samples across 18 endpoint variants, all HTTP 200 with zero transport, HTTP, body-limit or schema failures. The final cycle ended at the 90-second wall-clock limit, so execution.page and execution.detail have nine observations each and the other endpoints have ten. No rerun or padding request was made. The historical small-data phase had 180 actual samples.

| Endpoint | Samples | Status counts | Failures | Bytes p50/max | Latency p50 ms | p95 ms | p99 ms |
| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: |
| runs.latest | 10 | {"200":10} | 0 | 2173/2173 | 3.72 | 11.46 | 11.46 |
| loopies.counts | 10 | {"200":10} | 0 | 10450/10450 | 5.33 | 77.22 | 77.22 |
| runs.waiting | 10 | {"200":10} | 0 | 2/2 | 4.21 | 18.51 | 18.51 |
| runs.failed | 10 | {"200":10} | 0 | 2/2 | 3.65 | 21.07 | 21.07 |
| overview.counts | 10 | {"200":10} | 0 | 3212/3212 | 6.45 | 12.76 | 12.76 |
| logs.latest | 10 | {"200":10} | 0 | 4422/4422 | 8.06 | 17.81 | 17.81 |
| events.latest | 10 | {"200":10} | 0 | 11600/11600 | 4.00 | 36.79 | 36.79 |
| daemon | 10 | {"200":10} | 0 | 97/97 | 3.45 | 33.21 | 33.21 |
| runs.page2 | 10 | {"200":10} | 0 | 2/2 | 3.72 | 8.96 | 8.96 |
| runs.slug | 10 | {"200":10} | 0 | 996/996 | 3.87 | 8.91 | 8.91 |
| logs.text | 10 | {"200":10} | 0 | 901/901 | 3.96 | 40.28 | 40.28 |
| events.run-filter | 10 | {"200":10} | 0 | 6431/6431 | 4.88 | 17.60 | 17.60 |
| logs.page2 | 10 | {"200":10} | 0 | 4422/4422 | 3.76 | 6.94 | 6.94 |
| events.page2 | 10 | {"200":10} | 0 | 11510/11510 | 3.95 | 108.26 | 108.26 |
| run.snapshot | 10 | {"200":10} | 0 | 2809/2809 | 7.92 | 37.79 | 37.79 |
| run.payload | 10 | {"200":10} | 0 | 594/594 | 5.49 | 44.53 | 44.53 |
| execution.page | 9 | {"200":9} | 0 | 2552/2552 | 3.81 | 15.96 | 15.96 |
| execution.detail | 9 | {"200":9} | 0 | 1154/1154 | 4.03 | 9.44 | 9.44 |

The loopy-count observations retain 15 definitions and three runs throughout. These shared-client observations include API-slot acquisition and HTTP/body buffering. Each endpoint has at most ten samples, so p95 and p99 are observed maxima rather than reliable tail estimates. Historical comparison uses the exact same endpoint labels and phase; selected run IDs, time windows and cursors differ by dataset and capture time. Exact old/current per-endpoint counts, statuses, bytes and percentiles are saved in performance-repeat-baseline-small-validation.json. The HTTP response cannot establish R2 read counts or SQL-only cost.

Root reported terminal preflight IDs 3b677343-45e8-49b2-80f2-b30e68127b04, 8ebb0e76-4391-4818-8a54-e910aa9ef3ca, 79078fb4-a871-4f74-9bcf-3e422f1ceb52. Those IDs were supplied by root, without extra inventory API calls from this lane. Raw capture SHA-256 is cbe5057b2004d291889a62a36f5b6335dafc6bd0e9d0a1f15d9a37d15265f593. Root source-freeze manifest SHA-256 is 34369d678d2d9baf06841c5309e066c2e0b6aacf0d934d03c922d98bf73d682c. All 16 metrics source hashes still match preparation: true. No checks, compiles, browser, workload admissions or second sampler ran during this capture. Primary load remains root-gated.

# Continuous sampler started

At 2026-10-23T15:34:55.354Z, the single authorized during-load sampler was confirmed running as PID 46381, execution session 90588, using the exact architecture command with 3,600-second maximum and two-request-per-second target. Root primary dispatch had not yet been supplied. Dispatch time, actual first journal intent and actual first admission will be recorded separately. This lane will keep the sampler alive until root terminal gate and signal only this exact PID for its graceful final save. No matched-load segment has started yet.

# Primary interval start

Root supplied cohort dispatch at 2026-10-23T15:35:21Z. The retained current-batch primary journals independently give earliest intent 2026-10-23T15:35:22.353Z, group b, and earliest successful admission 2026-10-23T15:35:22.363Z, group b, run 8889fd05-1658-41c8-bca7-5819190c17f7. These are distinct boundaries. The earliest intent and earliest admitted record need not be the same run. This file-only inspection found 72 journal records and made no API call. Full start evidence is performance-repeat-primary-start.json.

# Matched active-load segment completed

The single authorized matched-load command exited 0 in session 8095. The segment ran from 2026-10-23T15:37:36.201Z through 2026-10-23T15:38:30.739Z, with exactly 36 requests, 18 alternating-order pairs and zero failures. The file-only launch check at 15:37:31.661Z found 118 primary journal records and 129.308 seconds since first intent. The already-saved continuous sample at 15:37:06.303Z observed 100 retained runs. No extra API probe established that gate.

The fixed routes are /runs?limit=50, /loopies and /event-history?limit=50. Each route/mode has six observations. Requests were sequential under the script one-request-per-second pacing. Direct reads bypass the shared four-slot filesystem semaphore and add at most one concurrent read beyond that pool. Continuous sampler PID 46381 stayed alive throughout.

| Endpoint and mode | Samples | Status counts | Failures | Bytes p50/max | Latency p50 ms | p95 ms | p99 ms |
| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: |
| runs.direct | 6 | {"200":6} | 0 | 32613/32906 | 404.12 | 1392.84 | 1392.84 |
| runs.shared | 6 | {"200":6} | 0 | 32396/32526 | 2020.70 | 5450.30 | 5450.30 |
| loopies.direct | 6 | {"200":6} | 0 | 101841/104315 | 370.01 | 1815.88 | 1815.88 |
| loopies.shared | 6 | {"200":6} | 0 | 101965/103585 | 46.66 | 6518.37 | 6518.37 |
| events.direct | 6 | {"200":6} | 0 | 11711/11850 | 7.20 | 972.08 | 972.08 |
| events.shared | 6 | {"200":6} | 0 | 11720/11858 | 8.56 | 802.92 | 802.92 |

The loopy observations span 134 to 145 retained runs, so the paired data changes during this segment. Direct timing includes local HTTP transport, server scheduling and body reads; shared timing also includes filesystem API-slot waits and buffering. These six-sample maxima do not establish reliable p95/p99 or an exact slot penalty. Neither boundary isolates SQL. Exact historical route/mode comparisons are in performance-repeat-matched-load-validation.json. Raw SHA-256 is 57ba7ed4ae71dfbd2abd9a316357e20858d629a53ef683b6e29ccf45666dbe76. No second matched-load segment will run.

# API measurement completed

The continuous sampler received SIGTERM only at its exact PID 46381 at 2026-10-23T15:51:08.833Z. Session 90588 exited 0 after final save, with 1,282 actual samples and zero failures. The authorized postload sampler then exited 0 with 178 actual samples and zero failures, followed by exactly 36 matched-postload requests with zero failures. The bounded inventory exited 0 and traversed 11 50-row pages to retain all 528 unique IDs, 464 succeeded and 64 failed. All 525 primary journal IDs match and have expected status, with no missing ID or status mismatch. The three root-supplied preflight IDs are present and succeeded. Excluding them leaves 525 primary IDs, 461 succeeded and 64 failed. No active or waiting run remains in the observed inventory.

All raw API captures finished before releasing root receipt-collector or graph-read traffic. Seven raw capture hashes, exact phase boundaries, all process exits and inventory identity evidence are pinned in performance-repeat-api-measurement-done.json. All 16 metrics source hashes still match preparation: true. Root source-freeze manifest SHA-256 is 34369d678d2d9baf06841c5309e066c2e0b6aacf0d934d03c922d98bf73d682c. No sampler remains running. Native SQL diagnosis remains gated on ROOTCLOSED-COPY.

# Complete HTTP comparison

All comparisons below use the same endpoint label and phase. The old captures are the original read-only JSON under .notes/cloud/evidence. Exact timestamps, response-byte distributions including maxima, statuses and unrounded percentiles are retained in performance-repeat-http-comparison.json. Run IDs, cursors, time windows, graph encodings and response bytes differ. The shared host and active mix were not isolated across dates.

## postload

Old 180 actual samples from 2026-10-22T20:27:45.473Z to 2026-10-22T20:29:16.012Z. Repeat 178 actual samples from 2026-10-23T15:51:14.094Z to 2026-10-23T15:52:45.005Z.

| Endpoint | Samples old / repeat | Statuses old / repeat | Failures old / repeat | Bytes p50 old / repeat | Latency p50 old / repeat ms | p95 old / repeat ms | p99 old / repeat ms |
| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: |
| runs.latest | 10 / 10 | {"200":10} / {"200":10} | 0 / 0 | 46596 / 43301 | 12.12 / 4.21 | 17.46 / 5.55 | 17.46 / 5.55 |
| loopies.counts | 10 / 10 | {"200":10} / {"200":10} | 0 / 0 | 121826 / 124634 | 19.96 / 8.53 | 27.83 / 22.50 | 27.83 / 22.50 |
| runs.waiting | 10 / 10 | {"200":10} / {"200":10} | 0 / 0 | 2 / 2 | 5.52 / 4.26 | 30.79 / 42.80 | 30.79 / 42.80 |
| runs.failed | 10 / 10 | {"200":10} / {"200":10} | 0 / 0 | 33481 / 33164 | 15.49 / 5.61 | 23.88 / 26.48 | 23.88 / 26.48 |
| overview.counts | 10 / 10 | {"200":10} / {"200":10} | 0 / 0 | 3218 / 3218 | 6.13 / 3.75 | 7.75 / 50.34 | 7.75 / 50.34 |
| logs.latest | 10 / 10 | {"200":10} / {"200":10} | 0 / 0 | 16857 / 16795 | 14.46 / 9.35 | 23.57 / 22.25 | 23.57 / 22.25 |
| events.latest | 10 / 10 | {"200":10} / {"200":10} | 0 / 0 | 11917 / 11926 | 10.95 / 7.95 | 13.59 / 64.89 | 13.59 / 64.89 |
| daemon | 10 / 10 | {"200":10} / {"200":10} | 0 / 0 | 97 / 97 | 4.99 / 3.68 | 8.50 / 27.76 | 8.50 / 27.76 |
| runs.page2 | 10 / 10 | {"200":10} / {"200":10} | 0 / 0 | 30875 / 31744 | 16.86 / 4.61 | 29.36 / 36.10 | 29.36 / 36.10 |
| runs.slug | 10 / 10 | {"200":10} / {"200":10} | 0 / 0 | 22081 / 22731 | 16.76 / 4.13 | 31.36 / 16.84 | 31.36 / 16.84 |
| logs.text | 10 / 10 | {"200":10} / {"200":10} | 0 / 0 | 18280 / 18280 | 12.98 / 9.33 | 20.03 / 54.68 | 20.03 / 54.68 |
| events.run-filter | 10 / 10 | {"200":10} / {"200":10} | 0 / 0 | 11627 / 11634 | 11.39 / 8.40 | 16.62 / 21.29 | 16.62 / 21.29 |
| logs.page2 | 10 / 10 | {"200":10} / {"200":10} | 0 / 0 | 16749 / 16811 | 13.89 / 9.41 | 18.09 / 24.39 | 18.09 / 24.39 |
| events.page2 | 10 / 10 | {"200":10} / {"200":10} | 0 / 0 | 12412 / 12290 | 8.75 / 8.16 | 13.56 / 24.15 | 13.56 / 24.15 |
| run.snapshot | 10 / 10 | {"200":10} / {"200":10} | 0 / 0 | 3852 / 3885 | 15.47 / 3.80 | 34.49 / 56.19 | 34.49 / 56.19 |
| run.payload | 10 / 10 | {"200":10} / {"200":10} | 0 / 0 | 467 / 493 | 4.59 / 3.30 | 6.94 / 28.34 | 6.94 / 28.34 |
| execution.page | 10 / 9 | {"200":10} / {"200":9} | 0 / 0 | 2691 / 2717 | 5.65 / 4.12 | 8.86 / 17.64 | 8.86 / 17.64 |
| execution.detail | 10 / 9 | {"200":10} / {"200":9} | 0 / 0 | 1116 / 1142 | 4.91 / 5.58 | 7.49 / 47.05 | 7.49 / 47.05 |

## matched-postload

Old 36 actual samples from 2026-10-22T20:29:40.141Z to 2026-10-22T20:30:16.123Z. Repeat 36 actual samples from 2026-10-23T15:52:47.940Z to 2026-10-23T15:53:23.953Z.

| Endpoint | Samples old / repeat | Statuses old / repeat | Failures old / repeat | Bytes p50 old / repeat | Latency p50 old / repeat ms | p95 old / repeat ms | p99 old / repeat ms |
| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: |
| runs.direct | 6 / 6 | {"200":6} / {"200":6} | 0 / 0 | 46596 / 43301 | 13.55 / 3.88 | 20.39 / 15.53 | 20.39 / 15.53 |
| runs.shared | 6 / 6 | {"200":6} / {"200":6} | 0 / 0 | 46596 / 43301 | 15.24 / 4.76 | 34.50 / 5.94 | 34.50 / 5.94 |
| loopies.direct | 6 / 6 | {"200":6} / {"200":6} | 0 / 0 | 121826 / 124634 | 18.60 / 9.59 | 32.28 / 22.51 | 32.28 / 22.51 |
| loopies.shared | 6 / 6 | {"200":6} / {"200":6} | 0 / 0 | 121826 / 124634 | 22.58 / 8.55 | 27.09 / 14.67 | 27.09 / 14.67 |
| events.direct | 6 / 6 | {"200":6} / {"200":6} | 0 / 0 | 11917 / 11926 | 8.85 / 11.61 | 12.34 / 16.71 | 12.34 / 16.71 |
| events.shared | 6 / 6 | {"200":6} / {"200":6} | 0 / 0 | 11917 / 11926 | 10.58 / 12.29 | 12.35 / 38.93 | 12.35 / 38.93 |

## Journal-aligned primary interval

Actual durable terminal timestamps are A 2026-10-23T15:45:22.306Z, B 2026-10-23T15:45:51.328Z, C 2026-10-23T15:49:18.633Z. They precede root-reported driver endedAt values of 15:45:24.277Z, 15:45:52.316Z and 15:49:20.039Z. Primary filtering uses first intent 2026-10-23T15:35:22.353Z through last durable terminal 2026-10-23T15:49:18.633Z, excluding 87 pre-intent samples and 215 post-terminal samples. All remain in the original continuous JSON. Requests are assigned by start timestamp, so a body may finish beyond a boundary.

The repeat interval spans 836280 ms with 980 samples and no failures. The old interval spans 695333 ms with 1201 samples and no failures. Mixed-endpoint p50/p95/p99 increased from 16.35/886.79/2150.67 ms to 20.79/2529.62/4869.37 ms. Those aggregates are context only. Endpoint comparisons follow.

| Endpoint | Samples old / repeat | Statuses old / repeat | Failures old / repeat | Bytes p50 old / repeat | Latency p50 old / repeat ms | p95 old / repeat ms | p99 old / repeat ms |
| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: |
| run.payload | 67 / 55 | {"200":67} / {"200":55} | 0 / 0 | 97 / 110 | 7.65 / 20.69 | 1007.75 / 3436.68 | 5436.64 / 4051.32 |
| execution.page | 67 / 55 | {"200":67} / {"200":55} | 0 / 0 | 1208 / 1208 | 8.98 / 21.83 | 534.44 / 3213.59 | 1043.34 / 4384.13 |
| execution.detail | 67 / 55 | {"200":67} / {"200":55} | 0 / 0 | 1106 / 1132 | 8.25 / 27.98 | 918.74 / 3270.89 | 3136.79 / 4630.03 |
| runs.latest | 67 / 55 | {"200":67} / {"200":55} | 0 / 0 | 32232 / 33171 | 17.34 / 48.81 | 1242.58 / 4393.99 | 3439.99 / 7161.70 |
| loopies.counts | 67 / 55 | {"200":67} / {"200":55} | 0 / 0 | 119763 / 122392 | 43.24 / 25.78 | 612.34 / 1027.85 | 993.94 / 2242.90 |
| runs.waiting | 66 / 55 | {"200":66} / {"200":55} | 0 / 0 | 2746 / 2798 | 17.07 / 11.60 | 1488.75 / 1768.72 | 2852.69 / 12423.87 |
| runs.failed | 66 / 55 | {"200":66} / {"200":55} | 0 / 0 | 31972 / 31456 | 24.53 / 8.97 | 572.30 / 1715.45 | 676.54 / 4245.40 |
| overview.counts | 66 / 55 | {"200":66} / {"200":55} | 0 / 0 | 3218 / 3218 | 11.64 / 11.45 | 1040.83 / 1049.77 | 2008.77 / 7357.85 |
| logs.latest | 66 / 54 | {"200":66} / {"200":54} | 0 / 0 | 15764 / 15645 | 14.81 / 139.18 | 489.50 / 3270.26 | 3236.56 / 9888.41 |
| events.latest | 66 / 54 | {"200":66} / {"200":54} | 0 / 0 | 11853 / 11850 | 11.87 / 22.53 | 886.79 / 2290.39 | 2664.51 / 2605.96 |
| daemon | 67 / 54 | {"200":67} / {"200":54} | 0 / 0 | 119 / 119 | 6.23 / 11.11 | 665.81 / 1725.17 | 3968.58 / 4646.00 |
| runs.page2 | 67 / 54 | {"200":67} / {"200":54} | 0 / 0 | 30277 / 31744 | 18.46 / 16.57 | 841.26 / 2433.30 | 1958.24 / 5327.81 |
| runs.slug | 67 / 54 | {"200":67} / {"200":54} | 0 / 0 | 16129 / 18352 | 16.94 / 29.01 | 1011.16 / 2625.46 | 2150.67 / 3267.87 |
| logs.text | 67 / 54 | {"200":67} / {"200":54} | 0 / 0 | 18267 / 18266 | 12.53 / 29.97 | 945.39 / 2342.80 | 3021.35 / 6430.79 |
| events.run-filter | 67 / 54 | {"200":67} / {"200":54} | 0 / 0 | 11563 / 11516 | 11.64 / 18.30 | 1200.71 / 2525.47 | 1867.56 / 3676.09 |
| logs.page2 | 67 / 54 | {"200":67} / {"200":54} | 0 / 0 | 15457 / 15503 | 15.02 / 26.83 | 750.44 / 3111.47 | 2645.44 / 4869.37 |
| events.page2 | 67 / 54 | {"200":67} / {"200":54} | 0 / 0 | 11853 / 11843 | 11.90 / 20.62 | 831.38 / 2992.34 | 5381.12 / 5327.92 |
| run.snapshot | 67 / 54 | {"200":67} / {"200":54} | 0 / 0 | 3258 / 3267 | 23.70 / 14.31 | 639.52 / 1449.14 | 1105.18 / 3727.37 |

The controlled postload /loopies shared-client median fell from 19.96 ms to 8.53 ms while response size changed from 121,826 to 124,634 bytes. Small-data /loopies median fell from 20.04 ms to 5.33 ms, but its repeat maximum was higher at 77.22 ms. During active load, direct matched /loopies maximum rose from 621.04 ms to 1,815.88 ms and shared maximum from 994.76 ms to 6,518.37 ms. This is mixed performance evidence. It supports lower observed quiescent metadata latency and persistent load-associated HTTP delays, without assigning a cause to SQL, receipt storage or the grouped-count change. Native SQL cannot isolate these live HTTP delays.

# Lifecycle and backend context

Journal analysis found all 525 primary terminal outcomes expected, with 461 succeeded and 64 controlled failures. Admission wall time p50/p95/p99/max is 108/2,345/5,720/6,518 ms. Terminal-from-admission p50/p95/p99/max is 6,088/45,745/54,077/63,361 ms. The 125 observed approval holds have p50 30,052 ms and maximum 48,997 ms, so terminal wall time is not execution service time. All three preflights succeeded separately. Journal parsing found zero invalid files or events.

The runtime file records 1,552 completed backend starts, matching the old count, with 1,511 successful provider outcomes and 41 execution failures. Repeat backend duration p50/p95/p99/max is 757/1,574/2,022/2,883 ms, compared with old 384/564/739/1,032 ms. Repeat backend-slot wait p50/p95/p99/max is 0/669/1,121/1,858 ms, compared with old 0/254/461/614 ms. This separate backend queue does not measure API-slot wait. Host process context includes 55 observations in the primary interval, and does not measure Docker guest/container CPU or establish a controlled hardware benchmark. No uncertain or transport-exception backend outcome is present.

One offline runtime-analysis invocation failed with ENOENT because I launched it concurrently with the segment file it required. I reran it after segment creation, and it exited 0. The failure is preserved in performance-repeat-analysis-failures.json; no API capture or database was involved.

# Source and unit evidence, separate from capture

The frozen 467-file source manifest aggregate is 93e0bcd0fccac0dbf8deff30aa0eb9e4b18ec15cac090c2ec6d8cb00ae8edc52. All 467 current file hashes still match it. Selected mechanism and test source hashes are pinned in performance-repeat-source-mechanisms.json.

At query-runs.ts:133-139, runCountsByDefinition executes one authoritative SELECT grouped by workspace, slug and status. run-views.ts:100-107 calls it once and maps the returned counts. The retained-run input remains O(N), with grouping and mapping costs in addition, rather than constant work or persisted totals. This removes repeated per-definition count scans; /loopies still selects recent runs and constructs views. The source establishes that mechanism. A 528-run HTTP capture does not establish the 100,000-run p95 budget or scalability.

At artifacts.ts:69-85, a valid generation-matched SQL projection returns before the R2 graph read. artifacts-definitions.ts:48-97 joins the separate projection table by workspace, slug and generation. Existing workerd test assertions at definition-summaries-workerd.test.ts:112-130 cover one cold graph read then zero warm reads, including after DO eviction; lines 216-244 distinguish zero-read warm service metadata from graph-validating get/start/schedule. The independent data-review-2.md reports focused real-workerd verification at its pinned source. This lane read those sources and that review but ran no tests. It did not instrument live R2 read counts, write amplification or prove zero R2 reads through HTTP timing. Root owns actual authority/result and R2 acceptance.

# Stopped-daemon copied SQL

Root separately approved the exact standalone .loopy/playground-daemon-architecture/daemon-readonly.sqlite after its 45-run workload and owned-daemon shutdown. Before opening SQLite, this lane verified a regular nonsymlink canonical path and SHA-256 ed037ac95b469b5a30616afb505fa1d2e6edfb8a4d4538250108d75a2c0b3bad. The existing architecture metrics-daemon-sql.ts command then exited 0. It opened only that approved copy read-only, without SqlRunStore construction, initialization, migrations, API requests or live database access.

Integrity check returned ok, journal mode was DELETE, and the copy matched all 45 saved API IDs/statuses, 39 succeeded and six failed. The database hash remained ed037ac95b469b5a30616afb505fa1d2e6edfb8a4d4538250108d75a2c0b3bad after close. An existing daemon-readonly.sqlite-shm sidecar was present before and after this diagnostic and was left untouched. The matching database hash and DELETE mode are recorded without describing this directory as sidecar-free.

| Table | Old daemon copy rows | Repeat daemon copy rows |
| --- | ---: | ---: |
| runs | 45 | 45 |
| node_runs | 457 | 457 |
| node_attempts | 466 | 466 |
| node_scopes | 72 | 72 |
| logs | 400 | 400 |
| events | 1321 | 1329 |
| waits | 9 | 9 |

| Operation | Parameters | Native SQLite query plan |
| --- | ---: | --- |
| runs.latest | 1 | SCAN r USING INDEX runs_created_id |
| runs.failed | 2 | SEARCH r USING INDEX runs_status_created_id (status=?) |
| counts.all | 0 | SCAN r USING COVERING INDEX runs_due |
| logs.candidates | 2 | SEARCH l USING INTEGER PRIMARY KEY (rowid<?); SEARCH r USING INDEX sqlite_autoindex_runs_1 (id=?) |
| events.candidates | 1 | SEARCH e USING INTEGER PRIMARY KEY (rowid<?); SEARCH r USING INDEX sqlite_autoindex_runs_1 (id=?) LEFT-JOIN |
| executions.page | 3 | SEARCH node_runs USING INDEX node_runs_scope (run_id=? AND scope=?) |
| execution.attempts | 3 | SEARCH node_attempts USING INDEX sqlite_autoindex_node_attempts_1 (run_id=? AND execution_key=? AND attempt>?) |

These seven source-derived plans describe native SQLite on the stopped 45-run copy. No query timings were collected. They do not prove remote Workerd parity, cloud performance or a controlled hardware comparison. The daemon uses host Bun/SQLite and its local sandbox, while the cloud uses DO SQL and Docker with separate attempt control. The raw artifact is playground-performance-daemon-offline-sql.json; the approval identity, artifact/source hashes, sidecar observations and exact old/current count/plan comparison are retained in performance-repeat-daemon-copy-approval.json and performance-repeat-daemon-sql-validation.json. Cloud copied SQL was still gated when this daemon section was recorded; the approved result follows.

# Closed Workspace copied SQL

Root approved exactly /Users/hatim.shakir/projects/loopy/cloud-integration/.loopy/playground-architecture/diagnostics/closed-snapshot-20261023T160158250238Z/standalone/loopy-playground-architecture-local-Workspace/c9fc980e43ecc368c89f7bc55f965f1da91aa94aa0bd54dd7515a5a571209ad3.sqlite. The existing architecture metrics-sql.ts postload-offline command exited 0. It checked the selected current-batch closed-copy.json manifest and approved SHA-256 before opening only that copy read-only. No live, raw, working or metadata database was opened. No SqlRunStore constructor, schema initialization, migration, immutable flag, FFI or write path was used.

Approved SHA-256 was 05ac0b40f0c0bbcfd69f8e04a470324a6d6c5632256d099e89e9ae8388d213d4 before and 05ac0b40f0c0bbcfd69f8e04a470324a6d6c5632256d099e89e9ae8388d213d4 after close. Integrity returned ok, journal mode was DELETE, and all 528 API IDs/statuses matched. The approved database had no WAL or SHM sidecar before or after. The directory also contains metadata.sqlite, which was only observed by filename and never opened. All seven source hashes were stable through the probe. The raw SQL artifact SHA-256 is 0c0a63236b8a35474e8f944777bc48318b4d77dad22918ec240934f4f9535801; approval manifest SHA-256 is 7457383448724c8231cbeabdd4d0d9f7a7ec8939f75284dde7225ed07a5f9aba. Full validation and historical comparison are in performance-repeat-cloud-sql-validation.json.

Root held fullcheck until SQL DONE. The cohort lane was also authorized to read this copied file for semantic census. These are ten native warm-cache repetitions per query on an uncontrolled shared host, with possible concurrent reads. They are not a hardware benchmark, Workerd latency, a remote parity result or reliable production p95/p99. SQL duration below excludes EXPLAIN and result hashing. The separately retained operation timer includes its first EXPLAIN but excludes later result hashing. Row-to-view construction, JSON schema work and application feed filtering are outside these SQL durations.

| Query operation | Calls old / repeat | Rows per call old / repeat | SQL p50 old / repeat ms | p95 old / repeat ms | p99 old / repeat ms | Same SQL text |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| runs.latest | 10 / 10 | 50 / 50 | 0.0343 / 0.0295 | 0.0615 / 0.0715 | 0.0615 / 0.0715 | true |
| runs.slug-workspace | 10 / 10 | 25 / 25 | 0.0176 / 0.0177 | 0.0393 / 0.0385 | 0.0393 / 0.0385 | true |
| runs.failed | 10 / 10 | 50 / 50 | 0.0339 / 0.0310 | 0.0464 / 0.0433 | 0.0464 / 0.0433 | true |
| runs.page2 | 10 / 10 | 50 / 50 | 0.0333 / 0.0315 | 0.0417 / 0.0394 | 0.0417 / 0.0394 | true |
| runs.waiting | 10 / 10 | 0 / 0 | 0.0606 / 0.0634 | 0.1097 / 0.1470 | 0.1097 / 0.1470 | true |
| counts.all | 10 / 10 | 2 / 2 | 0.0122 / 0.0119 | 0.0264 / 0.0290 | 0.0264 / 0.0290 | true |
| counts.slug-workspace | 10 / 10 | 1 / 1 | 0.0058 / 0.0068 | 0.0108 / 0.0112 | 0.0108 / 0.0112 | true |
| pending-hooks.historical-in-50 | 10 / 10 | 50 / 50 | 0.0268 / 0.0276 | 0.0546 / 0.0530 | 0.0546 / 0.0530 | true |
| pending-hooks.current-json-each-50 | 10 / 10 | 50 / 50 | 0.0280 / 0.0279 | 0.0318 / 0.0380 | 0.0318 / 0.0380 | true |
| pending-hooks.historical-in-99 | 10 / 10 | 99 / 99 | 0.0476 / 0.0493 | 0.0535 / 0.0529 | 0.0535 / 0.0529 | true |
| pending-hooks.current-json-each-99 | 10 / 10 | 99 / 99 | 0.0494 / 0.0497 | 0.0523 / 0.0579 | 0.0523 / 0.0579 | true |
| pending-hooks.historical-in-100 | 10 / 10 | 100 / 100 | 0.0555 / 0.0546 | 0.0595 / 0.0632 | 0.0595 / 0.0632 | true |
| pending-hooks.current-json-each-100 | 10 / 10 | 100 / 100 | 0.0527 / 0.0521 | 0.0567 / 0.0639 | 0.0567 / 0.0639 | true |
| pending-hooks.historical-in-200 | 10 / 10 | 200 / 200 | 0.1079 / 0.1158 | 0.1162 / 0.1292 | 0.1162 / 0.1292 | true |
| pending-hooks.current-json-each-200 | 10 / 10 | 200 / 200 | 0.1011 / 0.1055 | 0.1127 / 0.1133 | 0.1127 / 0.1133 | true |
| logs.candidates | 10 / 10 | 2001 / 2001 | 1.2692 / 1.3493 | 1.8669 / 2.5730 | 1.8669 / 2.5730 | true |
| logs.text-candidates | 10 / 10 | 2001 / 2001 | 1.3953 / 1.5446 | 1.4681 / 1.9563 | 1.4681 / 1.9563 | true |
| logs.run-candidates | 10 / 10 | 5 / 5 | 0.0088 / 0.0074 | 0.0253 / 0.0250 | 0.0253 / 0.0250 | true |
| events.candidates | 10 / 10 | 2001 / 2001 | 0.8351 / 0.8939 | 1.2762 / 1.9119 | 1.2762 / 1.9119 | true |
| events.run-candidates | 10 / 10 | 35 / 35 | 0.0207 / 0.0226 | 0.0377 / 0.0323 | 0.0377 / 0.0323 | true |
| executions.page | 10 / 10 | 7 / 7 | 0.0124 / 0.0109 | 0.0330 / 0.0346 | 0.0330 / 0.0346 | true |
| execution.attempts | 10 / 10 | 1 / 1 | 0.0049 / 0.0036 | 0.0160 / 0.0103 | 0.0160 / 0.0103 | true |
| scheduler.running | 10 / 10 | 0 / 0 | 0.0015 / 0.0015 | 0.0183 / 0.0204 | 0.0183 / 0.0204 | true |
| scheduler.ready | 10 / 10 | 0 / 0 | 0.0055 / 0.0052 | 0.0204 / 0.0171 | 0.0204 / 0.0171 | true |

| Table | Old Workspace copy rows | Repeat Workspace copy rows |
| --- | ---: | ---: |
| runs | 528 | 528 |
| node_runs | 4721 | 4721 |
| node_attempts | 4746 | 4746 |
| node_scopes | 604 | 604 |
| logs | 2727 | 2727 |
| events | 16913 | 17525 |
| waits | 126 | 126 |
| cloud_turns | 528 | 528 |

| Selected query | Repeat native SQLite plan |
| --- | --- |
| runs.latest | SCAN r USING INDEX runs_created_id |
| runs.waiting | SCAN r USING INDEX runs_created_id; CORRELATED SCALAR SUBQUERY 1; SEARCH w USING INDEX waits_run (run_id=?); SEARCH n USING INDEX sqlite_autoindex_node_runs_1 (run_id=? AND execution_key=?) |
| counts.all | SCAN r USING COVERING INDEX runs_due |
| logs.candidates | SEARCH l USING INTEGER PRIMARY KEY (rowid<?); SEARCH r USING INDEX sqlite_autoindex_runs_1 (id=?) |
| events.candidates | SEARCH e USING INTEGER PRIMARY KEY (rowid<?); SEARCH r USING INDEX sqlite_autoindex_runs_1 (id=?) LEFT-JOIN |
| executions.page | SEARCH node_runs USING INDEX node_runs_scope (run_id=? AND scope=?) |
| scheduler.ready | MULTI-INDEX OR; INDEX 1; SEARCH r USING INDEX runs_due (status=?); INDEX 2; SEARCH r USING INDEX runs_due (status=? AND wake_at<?); SEARCH t USING INDEX sqlite_autoindex_cloud_turns_1 (run_id=?) LEFT-JOIN; USE TEMP B-TREE FOR ORDER BY |

The source-exact historical IN and current json_each pending-hook queries return matching digests on the same terminal copied data at 50, 99, 100 and 200 selected IDs. The 200-ID form uses 201 versus two parameters. Native SQLite accepts both; this does not reproduce Workerd variable ceilings or independently prove unresolved-hook semantics. The ready/running scheduler queries return zero rows here, so their fast times and temporary ordering B-tree do not establish active scheduler cost or justify an index. Feed candidate retrieval still reads up to 2,001 rows even when the public result page is smaller. These plans and timings do not support an index change for this dataset.

The copied lifecycle has all 525 primary runs and expected 461/64 statuses. Queue-to-first-claim p50/p95/p99/max is 31/5,173/6,967/10,086 ms, compared with old 31/2,222/3,140/3,845 ms. This starts at service run creation and excludes client admission wait. First-node timestamps have the same distribution for this workload and include controls. Claim-to-terminal p50/p95/p99/max is 4,837/45,638/52,585/57,754 ms, including execution, polling and approval holds. All 126 durable waits completed and zero remain pending; the count includes the preflight hold, unlike the primary-only journal count of 125.

The preserved metrics SQL cases include all-status and one-definition filtered count queries, but do not time the new runCountsByDefinition grouping or measure summary R2 reads. Their source and unit evidence remains separate above. The old/new event count, 16,913 versus 17,525, describes retained events rather than write amplification, R2 operations or a causal source of delay. Root owns those separate acceptance receipts.

# Performance lane closeout

All authorized API phases, matched segments, identity inventories and approved copied-database diagnostics are complete. Sampler and probe processes exited 0; no sampler remains running. Failed analysis invocations and corrections remain preserved without deleting raw captures. No further API or SQL timing is needed from this lane. Root owns final repository checks, integration and independent acceptance.

This lane added this report and new performance JSON evidence under .notes/cloud/evidence/architecture. Existing metrics and production source files were not edited, and no tests were added, moved, deleted or run. No services, Docker operations, workload admissions, commits or delegates were started by this lane. The only signaled process was its own continuous sampler PID 46381. Historical private config, runtime state and databases were not read.
