# Playground cohort C

Status: primary cohort passed. One invocation completed all 125 actual runs with exit code 0. All 117 retained exports passed semantic validation. Durable admission and progress journals are retained.

Worktree: `/Users/hatim.shakir/projects/loopy/cloud-integration`, branch `cloud-integration`.

## Catalog and expected outcomes

The driver reads `packages/loopy/_tests_/fixtures/playground/c/modules/catalog.json`. Each `file` is relative to group C. All five entries have `burst: false` and export `loopies-playground/results/result.json`.

| Slug | Source | Approval | Behavior |
| --- | --- | --- | --- |
| `playground-c-data-migration` | `data-migration.ts` | Yes | Seed CSV records, hold approval, add a migration column, write a result receipt. |
| `playground-c-security-review` | `security-review.ts` | Yes | Seed policy and source, hold approval, check for forbidden calls, write a security review. |
| `playground-c-sleep-resume` | `sleep-resume.ts` | No | Seed records, suspend for two seconds, read persisted records and publish a totals report. |
| `playground-c-repository-validation` | `repository-validation.ts` | No | Seed a repository, validate three files in parallel, verify CSV identifiers, publish an integrity report. |
| `playground-c-artifact-manifest` | `artifact-manifest.ts` | Yes | Hash four seeded files, hold approval, check the saved manifest hash and publish it. |

Every workflow accepts exactly `{ batch: string, ordinal: number, fail: boolean, items: number[] }`. Every approval wait is named `approval` with payload `{ approved: boolean }` and a five minute timeout. Code tasks use ten second timeouts and one attempt.

The driver completed 25 runs per workflow, totaling 125 group C primary runs. It used `fail: false` for approval workflows and controlled failures at ordinals 5, 11, 17 and 23 for both nonapproval workflows. The three approval workflows also support `fail: true` after approval. They write the failed receipt before the final code task throws. Denied approval fails without publishing a result.

The Sol-owned cohort driver observes each wait, holds it for 10 to 45 seconds, then resolves it. Approval workflow code itself does not approve waits. The launch command, authorized by the root gate, is:

```sh
bun --no-env-file scripts/playground/index.ts cohort --group c
```

## Files and isolation

All bundle module references stay inside group C. Graphs import the public `loopy/graph` entry. The shared bundle helper derives the input type through the SDK's `Infer` type.

The first task seeds a small synthetic repository under the run's `loopies-playground` directory. Later tasks read or modify those files on the same run volume. Runs have isolated volumes. These fixtures do not mount or mutate the host repository directly. The driver freezes sources into the actual local git repository before compilation and later collects authenticated artifact bytes into its host result tree.

Result JSON includes top-level `batch`, `ordinal`, `slug`, and `outcome`. The inline task output includes the artifact path and a compact summary. Seed input arrays are capped at 24 records. The modules use local filesystem operations and SHA-256 only. No network access, personal files or credentials are required.

## Validation completed

- Local compiler invocation through `bun --no-env-file -e`, importing `packages/loopy/src/compiler/index.ts` and compiling every catalog entry. All five passed with zero warnings. Node counts were 6, 6, 6, 12, and 7. Bundle counts were 2, 2, 2, 5, and 3.
- `bunx --no-install eslint --fix packages/loopy/_tests_/fixtures/playground/c` passed after applying readable-spacing fixes.
- `bunx --no-install biome check --write packages/loopy/_tests_/fixtures/playground/c` printed `Checked 15 files in 3ms. No fixes applied.`
- Scoped TypeScript invocation through `bun --no-env-file -e`, creating a TypeScript program from the group's 14 TypeScript files with the repository compiler options. It printed `Scoped TypeScript check passed: 14 group C files.`
- Isolated compiled-bundle verification through `bun --no-env-file -` passed 13 scenarios. It executed generated bundle subprocesses in temporary workspaces, checked success and controlled failure for all five workflows, checked denied approval for all three approval workflows, and checked result identity and size. Maximum result size was 371 bytes. Maximum combined scenario stderr was 1,516 bytes. Temporary workspaces were removed.

The bundle verification compiled the final formatted sources again and found zero warnings. Those initial checks exercised executable modules and persisted workspace files. The primary cohort and post-run checks below add actual local stack execution, durable waits, sleep completion, delayed hook resolution, authenticated artifact exports and semantic verification. Dashboard UX acceptance remains with the parent review.

Before cohort launch, no broad check suite, commits, pushes, cloud calls, Docker mutations, shared-VM operations, or existing service changes were performed. No tests were added, deleted or moved. No child task was delegated.

## Primary cohort launch

The root opened the load gate for batch `playground-2026-10-22T19-54-57-063Z`, frozen seed `9e649e9a8abcb2ec20e4379190b893c6876931b0`, independently accepted guard SHA `1213d36290bf1cf94a7587cc54d6320bda41cba2d6a6ccc29943af8b278c42a9`.

One invocation was started as PID `19798`. The durable cohort lock records `2026-10-22T20:14:15.206Z`. The operating-system process listing records local start `Fri Oct 23 01:44:15 2026`, UTC+05:30. Terminal session ID is `96109`.

Admissions and approval progress remain under `.loopy/playground/journal/primary/c/`. The append-only event stream is `.loopy/playground/journal/c.jsonl`. Retained result JSON lives under `.loopy/playground/loopies-playground/results/playground-2026-10-22T19-54-57-063Z/playground-c-*/`.

## Primary cohort outcome

The driver summary is `.notes/cloud/evidence/playground-driver-primary-c.json`. Its recorded interval is `2026-10-22T20:14:15.215Z` through `2026-10-22T20:25:48.127Z`, a wall time of 692,912 ms, or 11 minutes 32.912 seconds. Terminal session `96109` exited with code 0. No restart or second cohort invocation occurred.

| Workflow | Actual runs | Succeeded | Controlled failure | Resolved approvals | Host artifacts |
| --- | ---: | ---: | ---: | ---: | ---: |
| Data migration | 25 | 25 | 0 | 25 | 25 |
| Security review | 25 | 25 | 0 | 25 | 25 |
| Sleep and resume | 25 | 21 | 4 | 0 | 21 |
| Repository validation | 25 | 21 | 4 | 0 | 21 |
| Artifact manifest | 25 | 25 | 0 | 25 | 25 |
| Total | 125 | 117 | 8 | 75 | 117 |

No unexpected terminal outcomes were recorded. Each of the eight failures had error code `execution` in the expected final code node, `resume-report` or `repository-report`, with the exact marker `PLAYGROUND_CONTROLLED_FAILURE: requested final validation failure.`. The driver classified all eight as controlled failures. They represent four of 25 runs for each nonapproval workflow, or 16% of those 50 runs.

All 75 waits used the `approval` hook and resolved with `{ approved: true }`. Scheduled holds ranged from 10,000 to 45,000 ms. Observed holds, calculated from the durable observation and resolution timestamps, ranged from 10,567 to 48,633 ms, with a median of 28,766 ms. Six observed holds exceeded 45 seconds. These include polling and request overhead; every observed hold met or exceeded its own scheduled delay. Every run's scheduled and observed hold is retained in the semantic evidence.

No ABORT guard was present at completion. No ambiguous admission or approval was repeated. No services were restarted or stopped. Sources, runtime code, credentials, personal state, cloud deployments and main were untouched during this phase. The stack remains running.

## Post-run semantic evidence

`.notes/cloud/evidence/playground-cohort-c-semantics.json` records all 125 run IDs, their complete journaled fixture inputs, terminal outcomes, every retained artifact path and digest, failure evidence, approval timestamps, and parallel outputs. It is a bounded group C receipt. The existing admission and progress files remain the durable per-run records.

After the cohort exited, a `bun --no-env-file -` validation script read the retained JSON exports and fetched contract-validated run snapshots through `PlaygroundClient`. Reads were sequential and respected the existing global API slots. No fixture implementation functions were imported to derive expected values.

- All 117 host JSON artifacts exactly matched the expected objects recomputed from admission inputs. The checks covered CSV source hashes, migrated CSV hashes and record counts, security policy and source hashes, zero findings, resumed totals, validated file lists, manifest file counts and manifest hashes.
- All 25 repository-validation runs had successful parallel joins and all 75 child validation outputs matched the independent expected file names, byte counts and hashes. This includes the four runs whose final report intentionally failed.
- Every seed output, successful final summary output and manifest preparation output matched its independent expected value.
- All 75 wait node outputs and hook histories contained approved true. Every scheduled and observed hold was checked.
- All 25 sleep nodes completed and pinned a graph duration of two seconds. Their persisted timestamps are retained without treating them as a full scheduling-latency measurement.
- All 350 executable node records had one attempt and a finished receipt. Group C has no map or retry workflow, so no retry recovery is claimed.
- All eight failed runs had exactly one failed node, with the expected label, execution error code and controlled marker.

The semantic script printed `status: passed`, with 125 runs, 117 artifacts, 25 parallel runs, 75 validated parallel children, 75 approvals, 25 sleeps and 350 executable nodes.

The driver exports only succeeded runs. The eight controlled failures therefore have no host artifact, although their modules write a receipt before throwing inside the sandbox. Their exact persisted failure evidence is retained instead. Intermediate CSV and Markdown files are not separate host exports; the checked result fields and persisted node outputs support their semantics without claiming direct host copies.
