# Playground cohort A

Status: completed. All 200 primary local cloud runs are terminal, with 172 successes,
28 exact controlled failures, and zero unexpected outcomes. All 172 exported results
passed workflow-specific semantic validation.

Owned source is `packages/loopy/_tests_/fixtures/playground/a/` on branch `cloud-integration`.
Catalog is `packages/loopy/_tests_/fixtures/playground/a/modules/catalog.json`.
Its `file` values are relative to group A.

## Catalog and expected outcomes

| Slug | File | Runs | Approval | Behavior |
| --- | --- | ---: | --- | --- |
| playground-a-format-report | format-report.ts | 100 | No | Seed sources, normalize trailing whitespace, write reports/format.md. First burst entry. |
| playground-a-lint-report | lint-report.ts | 25 | No | Map source lint checks with concurrency 2, write reports/lint.md. Whitespace findings are advisory. |
| playground-a-dependency-audit | dependency-audit.ts | 25 | No | Parallel inventory and review scans of synthetic dependencies, write reports/dependencies.md. No vulnerability service. |
| playground-a-changelog-approval | changelog-approval.ts | 25 | Yes | Draft changelog, suspend on approval, publish CHANGELOG.md after approved:true. |
| playground-a-generated-docs | generated-docs.ts | 25 | No | Map source exports into docs sections with concurrency 2, sleep 200 ms, write docs/api.md. |

Group A totals 200 primary runs. The driver supplies `fail:false` for approvals and
approximately one controlled failure per six runs for the other workflows. This gives
about 172 successes and 28 expected failures, depending on ordinal indexing. Only the
format workflow has `burst:true`.

Every graph declares exactly this input:

```ts
{ batch: "string", ordinal: "number", fail: "boolean", items: "number[]" }
```

All workflows seed a small synthetic repository in the run's isolated `/workspace`
volume under `loopies-playground/`. Subsequent tasks read and modify those files.
Runs do not read a host repository mount. The driver freezes these source fixtures
into the actual local git repository before compilation and upload.

Each success writes `loopies-playground/results/result.json`. Its top-level fields
are `batch`, `ordinal`, `slug`, and `files`. Each file contains a repository-relative
`path` and generated `content`. The driver exports authenticated artifact bytes,
checks the hash and identity, and saves the JSON into host repository
`results/<batch>/<slug>/<runId>.json`. The file content embedded in JSON is also
written to the sandbox repository; applying those text files to the host is not
part of this fixture contract.

Nonapproval `fail:true` takes a DSL failure branch after source reads. The changelog
workflow also supports `fail:true`: it fails after approval resolves with
`approved:true`, before publishing. `approved:false` is a final failure. There is
one wait, named `approval`, with payload `{ approved: boolean }` and a five-minute
deadline. The primary driver will observe the wait, hold for 10–45 seconds, then
resolve it under the Sol lead's ownership.

Executable tasks use a 20-second timeout and one attempt. No retries, network calls,
personal files, secrets, or external effects are needed. Artifact serialization
enforces an 8 KiB ceiling. Changelog and docs output cap generated sections at eight.

## Local validation

All checks ran before load. No broad repository check was run.

- `bunx --no-install biome check --write packages/loopy/_tests_/fixtures/playground/a`
  checked 17 files and initially formatted 14. The final read-only check printed
  `Checked 17 files in 4ms. No fixes applied.`
- `bunx --no-install eslint --fix packages/loopy/_tests_/fixtures/playground/a`
  fixed spacing and array notation. It exited 0 with no remaining diagnostics.
- A scoped TypeScript API invocation through `bun --no-env-file -e` loaded the root
  tsconfig and used only the 16 group A TypeScript files as program roots. It printed
  `Scoped TypeScript: 16 files, 0 diagnostics`.
- A local compiler invocation through `bun --no-env-file -e` compiled each catalog
  file with `packages/loopy/src/compiler/index.ts`. All five passed. Node and bundle
  counts respectively were format 8/2, lint 12/3, dependency 14/4, changelog 14/3,
  and docs 13/3.
- An inline `bun --no-env-file -` harness compiled and spawned the actual emitted
  bundles in temporary workspaces, drove graphs through `activate` and `MemoryStore`,
  resolved approval hooks through `resolveWait`, and cleaned up each temporary
  workspace. It checked all five successes and controlled failures, declined
  approval, and empty-map success for lint and docs. It printed
  `Local emitted-bundle validation: 13 cases passed`.

The harness checked final status, artifact identity, generated-file content against
the JSON export, artifact size, and bundle log size. Successful artifacts were
268–567 bytes. Maximum observed bundle log bytes were 429. This is local emitted
bundle and host/reducer proof, not cloud, Docker, daemon, SQL, or dashboard proof.
The first harness attempt incorrectly inspected a nonexistent hook status field;
the corrected harness used the source contract's resolvedAt/expiredAt fields.

No tests were added, removed, or moved. No child agents were delegated. No commits
were created. Source preparation changed only the group A fixture directory and
this note. Measurement added the evidence described below.

## Authorized primary measurement

Root opened the load gate for batch `playground-2026-10-22T19-54-57-063Z` with frozen
mock repository seed `9e649e9a8abcb2ec20e4379190b893c6876931b0` and accepted guard SHA
`1213d36290bf1cf94a7587cc54d6320bda41cba2d6a6ccc29943af8b278c42a9`.
The group A Sol lead invoked this command exactly once:

```sh
bun --no-env-file scripts/playground/index.ts cohort --group a
```

PID was `19569`, with lock start time `2026-10-22T20:14:11.928Z`, or
01:44:11.928 IST on October 23. The driver's measurement ran from
`2026-10-22T20:14:11.935Z` to `2026-10-22T20:20:44.757Z`, lasting 392,822 ms.
The process exited 0. No rerun, restart, admission recovery, manual POST, or ABORT
clear occurred. The driver summary status is `passed`.

| Workflow | Admitted and terminal | Succeeded | Controlled failures | Semantic exports checked |
| --- | ---: | ---: | ---: | ---: |
| Format report | 100 | 84 | 16 | 84 |
| Lint report | 25 | 21 | 4 | 21 |
| Dependency audit | 25 | 21 | 4 | 21 |
| Changelog approval | 25 | 25 | 0 | 25 |
| Generated docs | 25 | 21 | 4 | 21 |
| Total | 200 | 172 | 28 | 172 |

The 28 failure causes exactly matched the intended DSL markers, including the full
terminal error string, and occurred only at nonapproval ordinals where
`ordinal % 6 === 5`:

- 16 format failures: `Controlled format check failure requested by fixture input.`
- 4 lint failures: `Controlled lint gate failure requested by fixture input.`
- 4 dependency failures: `Controlled dependency policy failure requested by fixture input.`
- 4 docs failures: `Controlled generated documentation failure requested by fixture input.`

All 25 approval runs completed after delayed resolution of `approval`. Configured
holds were 10–45 seconds. Actual observed holds were 11,439–46,330 ms, and every
resolution was at or after its recorded due time. The largest due-time overshoot
was 1,976 ms. One actual hold exceeded 45 seconds: ordinal 5, run
`0f67d1c1-7ff6-4c64-b7ba-71f50765aab8`, held 46,330 ms against its 45,000 ms schedule.
Its due-time overshoot was 1,330 ms. This timing deviation is retained in evidence.

## Export semantics and retained evidence

An inline `bun --no-env-file -` validator read the primary driver summary,
all 200 admitted and terminal journal events, every durable progress result, and all
172 exported JSON files. It checked unique run IDs and exact per-workflow counts.
Every successful export exists in the expected batch/slug/runId path, matches its
recorded hash and byte count, and stays within 8 KiB. The export directories contain
exactly the expected 172 group A primary result files.

Semantic checks went beyond identity and hashes:

- All 84 format reports name three changed files, README.md, src/math.ts, and
  src/status.ts, with no omitted or extra source paths.
- All 21 lint reports contain exactly two mapped source checks and two whitespace
  findings, matching their two input items, and retain the advisory policy.
- All 21 dependency reports agree with both parallel scans: two dependency inventory
  rows and one review item. The two named synthetic dependencies and their statuses
  are present.
- All 25 changelogs contain the ordered maintenance items from their individual run
  inputs, the expected headings, the approval attestation, and a completed delayed
  hook before terminal completion.
- All 21 docs exports preserve the input item order, alternate the expected source
  paths, and include the actual seeded sum/status TypeScript declarations in their
  corresponding fenced sections.

Retries do not apply to group A. Its executable nodes are configured for one attempt.
No runtime or fixture source changed during this measurement or validation.

The validator printed `status: passed`, `terminal: 200`, `succeeded: 172`,
`controlledFailures: 28`, and `artifactsSemanticsPassed: 172`. It saved one bounded
152,205-byte semantic evidence file containing every run ID, ordinal, classification,
artifact path/hash, semantic check, exact failure cause, and approval timing.

- Driver summary: `.notes/cloud/evidence/playground-driver-primary-a.json`
- Semantic evidence and all run IDs: `.notes/cloud/evidence/playground-semantics-a.json`
- Durable admissions and progress: `.loopy/playground/journal/primary/a/`
- Event history: `.loopy/playground/journal/a.jsonl`
- Retained exports: `.loopy/playground/loopies-playground/results/playground-2026-10-22T19-54-57-063Z/playground-a-*/<runId>.json`

Reserved stack ports are 15070, 15071, 15072, and 15073. Workspace is `playground`,
state is `.loopy/playground`, and Docker context is `colima-loopy-cloud-phase1`.
Existing ports 4310, 4173, and 14870–14873 remain untouched. Do not stop the shared
VM. The stack remains running. This is local Wrangler/Docker evidence. No remote
cloud, main checkout, personal state, production edits, or commits were involved.
