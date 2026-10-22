# Playground cohort B

Group B completed on `cloud-integration` after the root load gate opened. The single cohort invocation completed all 200 primary runs. No child agent was spawned.

## Catalog and outcomes

Catalog: `packages/loopy/_tests_/fixtures/playground/b/modules/catalog.json`. Driver discovery reads `GROUP/modules/catalog.json`. Its `file` entries remain relative to the group B root, not the modules directory. Every workflow accepts exactly `{ batch: string, ordinal: number, fail: boolean, items: number[] }`.

| Slug | File | Runs | Behavior |
| --- | --- | ---: | --- |
| `playground-b-test-matrix` | `test-matrix.ts` | 100 | Seed source files, map test shards with concurrency 2, publish scores. `fail:true` fails the policy branch after shards finish. First entry has `burst:true`. |
| `playground-b-parallel-build` | `parallel-build.ts` | 25 | Seed sources, build client and server summaries in parallel, merge their files. `fail:true` fails the policy branch after both builds finish. |
| `playground-b-retry-marker` | `retry-marker.ts` | 25 | Seed sources, write a safe first-attempt marker, fail attempt one. Attempt two updates source values and succeeds when `fail:false`. `fail:true` fails both attempts. |
| `playground-b-release-approval` | `release-approval.ts` | 25 | Seed sources, wait on `approval` with `{ approved: boolean }`, write the approved release. A false approval or `fail:true` fails after wait resolution. Driver plans `fail:false` for these runs. |
| `playground-b-log-audit` | `log-audit.ts` | 25 | Seed sources, emit 12 to 20 audit records, write sorted source values and audit documentation. `fail:true` fails after logging evidence. |

Total is 200 primary runs. Nonapproval workflows support the driver's approximately one-in-six controlled final failures. The retry policy permits two total attempts with the engine's fixed exponential delay, which starts at one second. Other code tasks permit one attempt. Every code task has a 10-second timeout. Approval has a five-minute timeout, allowing the driver's planned 10 to 45 second hold.

## Repository and artifacts

All module references stay within group B. Builder imports use `loopy/graph`. Bundles use only local filesystem operations and bounded logs.

Each run seeds a logical `loopies-playground` directory under its isolated sandbox `/workspace`. It contains `src/ci-values.txt`, a README and batch documentation. Later tasks read those files. Build, test, retry, release and audit tasks write useful derived files. Runs do not mount or directly update the host repository.

Every successful workflow writes `loopies-playground/results/result.json`. Its top-level fields include `batch`, `ordinal`, `slug`, `summary`, `values` and `checksum`. Outputs are deterministic for the supplied input. Controlled failures leave no final result artifact. The driver fetches the authenticated artifact, checks bytes and hash, then writes the actual host git repository at `results/<batch>/<slug>/<runId>.json`.

## Local validation

All checks were scoped to group B. No broad checks, Docker operations, service changes, cloud requests or credential reads were needed.

- Local compiler, invoked through `bun --no-env-file -e` with `compile` from `packages/loopy/src/compiler/index.ts`, accepted all five catalog entries. Node counts are 12, 14, 4, 5 and 4. Bundle counts are 3, 4, 2, 2 and 2.
- `bunx --no-install eslint packages/loopy/_tests_/fixtures/playground/b` exited 0 with no findings.
- `bunx --no-install biome check packages/loopy/_tests_/fixtures/playground/b` printed `Checked 15 files in 3ms. No fixes applied.`
- Scoped TypeScript used the root tsconfig options and a program containing only group B source files as roots. It printed `Scoped TypeScript: 14 files, 0 diagnostics`.
- A temporary local harness compiled all entries, executed their emitted bundles in disposable directories inside group B, then removed itself and those directories. `bun --no-env-file packages/loopy/_tests_/fixtures/playground/b/.verify.mjs` passed ten cases, covering each workflow with `fail:false` and `fail:true`. It executed 32 bundles, including five expected bundle failures. It checked artifact identity, checksum and absence after controlled failures. Maximum artifact size was 149 bytes and maximum captured logs per case were 4,826 bytes for input `{ batch: "verify-b", ordinal: 6, fail, items: [1, 3, 5, 7] }`.

The temporary harness inspected compiled map, parallel, policy-failure and wait nodes. It did not exercise host scheduling, SQL, HTTP, Docker execution, actual wait duration or cohort throughput. The actual cohort results below cover the local driver run. The temporary harness size measurements apply to its tested small synthetic input.

No existing tests were deleted or moved. Retained authored changes are fixture sources, modules, catalog, this note and bounded semantic evidence. No runtime source edits or commits were made.

## Authorized cohort execution

Root opened the load gate for batch `playground-2026-10-22T19-54-57-063Z`, frozen seed `9e649e9a8abcb2ec20e4379190b893c6876931b0`, accepted guard SHA-256 `1213d36290bf1cf94a7587cc54d6320bda41cba2d6a6ccc29943af8b278c42a9`. This lead invoked the command exactly once:

```sh
bun --no-env-file scripts/playground/index.ts cohort --group b
```

PID was `19555`, with process start `2026-10-23 01:44:11 IST`, equivalent to `2026-10-22 20:14:11 UTC`. The driver receipt records `2026-10-22T20:14:11.471Z` through `2026-10-22T20:20:50.558Z`, an elapsed 399,087 ms. The process exited 0 and receipt status is `passed`.

| Workflow | Terminal runs | Succeeded | Controlled failures | Retained result files |
| --- | ---: | ---: | ---: | ---: |
| Test matrix | 100 | 84 | 16 | 84 |
| Parallel build | 25 | 21 | 4 | 21 |
| Retry marker | 25 | 21 | 4 | 21 |
| Release approval | 25 | 25 | 0 | 25 |
| Log audit | 25 | 21 | 4 | 21 |
| Total | 200 | 172 | 28 | 172 |

All 200 durable admissions have distinct run IDs and terminal receipts. No unexpected outcomes occurred. `ABORT` was absent after completion. The observed controlled failure inputs are exactly the nonapproval runs with `ordinal % 6 === 5`.

Failure markers matched the owning node definitions through driver classification:

- Matrix, 16 runs: `Controlled test matrix policy failure`.
- Parallel build, 4 runs: `Controlled build size policy failure`.
- Retry marker, 4 runs: `Controlled CI retry failure. The retry marker is safe to inspect.` Both permitted attempts fail for these inputs.
- Audit, 4 runs: `Controlled audit policy failure after bounded evidence logs.`

All 25 approvals resolved through the driver after their due times. Scheduled delays ranged from 10 to 45 seconds. Observed holds ranged from 10,816 to 45,594 ms, with median 28,986 ms. Polling and API resolution add up to 594 ms beyond the largest scheduled delay. Each wait record retains its observed, due and resolved timestamps.

## Export semantic validation

After the command completed, a bounded read validated all 172 exported files against their admission inputs, plus 25 sequential run-snapshot reads through the existing client and global API limiter for retry evidence. No new runs, approvals or retries were submitted.

- Matrix values equal `abs(item) * 3 + index` in source item order.
- Parallel values equal independent client and server totals, using multipliers 2 and 5 and adding 16 per item.
- Successful retry values increment every seeded value by one. All 25 retry nodes, including four controlled final failures, ended with `attempt: 2`, `maxAttempts: 2` and a finished receipt.
- Release values equal the approved seeded values.
- Audit values are sorted numerically, and the summary reports `12 + ordinal % 9` records.
- Every result has the exact expected summary, values, checksum, batch, ordinal and slug. Byte length and SHA-256 also match the driver export record. Maximum retained artifact size is 172 bytes.
- All 28 controlled failures have no retained result file. Each workflow directory contains exactly its successful run count.

Evidence and retained state:

- Driver receipt with all 200 results: `.notes/cloud/evidence/playground-driver-primary-b.json`.
- Semantic evidence with all 200 run IDs, outcomes, controlled error messages, expected result values, retry nodes and 25 wait records: `.notes/cloud/evidence/playground-cohort-b-semantics.json`.
- Admission and progress records: `.loopy/playground/journal/primary/b/`.
- Event journal, including admission, wait, resolution and terminal events: `.loopy/playground/journal/b.jsonl`.
- Retained exports: `.loopy/playground/loopies-playground/results/playground-2026-10-22T19-54-57-063Z/<slug>/<runId>.json`.

The local stack remains running on ports 15070 through 15073, workspace `playground`, state `.loopy/playground`. No source changes, broad checks, service restarts, state clearing, personal-state operations or commits were performed during the run or semantic validation.
