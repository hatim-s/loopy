# Playground evidence review

Approve the completed evidence claims. No material count contradiction, unsupported SQL attribution or runtime-parity claim found in the final performance, daemon and cohort reports.

Reviewed independently on branch `cloud-integration` in `/Users/hatim.shakir/projects/loopy/cloud-integration`. Scope is the local workload and diagnostic addition, a minor feature. The separately reviewed pagination change is a minor bug fix. Read AGENTS.md, unslop, pr-review, the performance/daemon/driver/cohort reports, pagination proof/review and their relevant saved JSON. Only this review file was written. No source edits, services, Docker, database access, API calls, credentials, workload reruns, tests, commits or delegation.

## Offline reconciliation

- Primary receipts contain 525 distinct runs across 15 slugs. A and B each have 200 runs, 172 successes and 28 controlled failures. C has 125 runs, 117 successes and eight controlled failures. All actual statuses match expectations. The three succeeded preflights produce exactly the saved 528-ID inventory, with 464 successes and 64 failures. The prior 22 runs belong to separate retained stacks.
- All 461 successful primary exports still match their recorded byte lengths and SHA-256 values. All cohort semantic receipts match the primary IDs, statuses and artifact digests. The 64 failure records have controlled classifications and the expected ordinal policy. The 125 primary approval holds have median 28,947 ms and maximum 48,633 ms. Ten to 45 seconds describes scheduled holds, not a guaranteed observed ceiling.
- The daemon's 45 IDs/statuses reconcile with its saved API census, with 39 successes, six expected failures and nine holds. The complete execution supplement independently sums to 457 latest executions, 466 attempts, 72 scoped executions and 400 logs. All 272 retained output files and 178 recorded finished receipt files still match their hashes. Root-only snapshot counters are superseded for complete totals.
- Recomputed sampler totals agree: 140 empty-baseline requests, 180 small-baseline requests, 180 post-load requests and 36 requests in each matched segment, all successful. The continuous file has 2,811 samples. Exactly 1,201 fall in the declared primary interval, with zero failures and p50/p95/p99/max of 16.35/886.79/2,150.67/5,436.64 ms. The 1,552 provider starts separately reconcile to 1,511 successes and 41 execution failures.
- The native SQL JSON's largest warm median is 1.395 ms across its 24 operation summaries. Cloud/daemon table counts agree with the completed reports. The pagination receipt records successful 99/100/200-row pages, rejection of 201 and an exact 200+200+128 traversal of the same 528 IDs with zero added runs. Actual Workerd regression and negative-control results belong to the separate independent pagination review.

## Limits the final report must retain

The shared sampler includes filesystem permit wait and body buffering. Direct samples bypass that permit but still include transport and server scheduling. Their load-associated delays do not identify SQL cost. Native warm-cache SQL on a terminal copied dataset excludes view conversion and application filtering, does not reproduce Workerd's binding limit and cannot establish production tails or active scheduler cost. No index recommendation follows.

The serial host Bun daemon and concurrent Workerd/Docker workload establish behavior under different conditions. They do not establish throughput or latency parity. The daemon's source hashes document the SQL edit during execution; its startup imports predate that edit. Its five-second activation-delay observation applies to the recorded run. The separate wake fix in progress is outside this review, and no post-fix performance claim is approved here.

`PLAYGROUND.md` preparation and launch checkpoints, initial failed snapshot attempts, zero-run daemon backup preflight and root-only daemon counters are historical records. Their pending states do not override the completed performance/daemon reports and final receipts. The SQL timing correction withdraws the unproved concurrent-daemon label without claiming isolated host activity.

This review reconciles saved evidence and retained file bytes. It does not independently reimplement every fixture's semantic transformation, rerun Workerd correctness checks, establish current listener/process state, inspect dashboard UX or approve full-repository checks. Those remain with their respective owners.
