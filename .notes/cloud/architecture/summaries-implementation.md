---
title: Definition summaries and direct service lookup
status: P2 repaired, focused checks passed, root integration pending
head: 6ffecdfd60e16aaa335467684d918b3cd8b44813
---

## Current result

The P2 in `data-review-1.md` is repaired. This receipt supersedes the previous pointer-row summary design and its hashes. The original source snapshot is preserved under the fresh evidence directory's `before/` folder. Root's accepted correction selects an always-separate cloud SQL projection instead of inline JSON or conditional overflow storage. Shared schema 15, native registry format and public summary signatures are unchanged.

Owned P2 source/test delta from the reviewed source is **+585 / -48** across ten files, plus this updated note. No commits, pushes, main operations, workload runs, shared services, deployment or children were started by this lane. This lane did not run a fullcheck. Root reported its earlier fullcheck separately. The native-fixture incident below prevents claiming that every attempted test run stayed isolated.

## Public contract

The existing `definitionSummarySchema`, inferred `DefinitionSummary`, and `definitionSummary(saved: SavedLoopy): DefinitionSummary` remain unchanged. The public summary fields are `slug`, `revision`, `source`, `savedAt`, `scope`, `description`, `input`, `schedule`, and `mode`. JSON-root inputs display `"schema"`. Graphs, nodes, executable bundles, validation internals and secret names remain absent.

```ts
interface ArtifactRegistry {
  workspace(): Promise<string>;
  listSummaries(): Promise<DefinitionSummary[]>;
  summary(slug: string): Promise<DefinitionSummary | null>;
  get(slug: string): Promise<SavedLoopy>;
  revisionGraph(revision: string): Promise<Graph>;
  revisionSource(slug: string, revision: string): Promise<SourceArtifact>;
  save(body: PutLoopyBody): Promise<void>;
}
```

No new barrel exports are required. `ARTIFACT_LIMITS.metadataRowBytes` is `2 * 1024 * 1024 - 1024`, or 2,096,128 bytes. Other limits remain unchanged, including the 1 MiB graph cap and aggregate 32 MiB current-graph quota.

## Storage and byte contract

`artifact_definitions` retains its original six columns. Source, slug, revision and savedAt are stored there once. The unpublished nullable `summary_json` column is no longer created, read or written. No compatibility reader, column migration, R2 overflow references or shared schema changes were added.

```sql
CREATE TABLE IF NOT EXISTS artifact_definition_summaries (
  workspace TEXT NOT NULL,
  slug TEXT NOT NULL,
  generation TEXT NOT NULL,
  projection_json TEXT NOT NULL,
  PRIMARY KEY (workspace, slug)
);
```

`projection_json` contains only `scope`, `description`, `input`, `schedule` and `mode`. Its strict schema is derived from the existing public summary schema, and its type is inferred. Reads join on workspace, slug and generation and reconstruct the public summary from pointer fields plus this projection. Neither source, revision nor savedAt is repeated inside the stored JSON. The identity columns identify the projection and fence its generation.

Publication writes the pointer and projection in the same existing synchronous transaction, after immutable artifact writes. Owner, generation and quota checks remain. A same-save repairs missing or corrupt metadata without changing generation or savedAt; a matching projection keeps the early return. Cold backfill reads graphs outside transactions, rereads the pointer and installs a projection only if the generation remains current and no matching projection exists. Valid, missing and corrupt old graphs racing a save retain their covered behavior. SQL failures roll back both rows.

New publication checks run inside `checkArtifactLimits`, before validation can reach any R2 write. Each physical SQL row has its own explicit combined UTF-8 byte bound:

- Pointer: workspace + slug + revision + source path + 36 UUID bytes + 27 reserved ISO timestamp bytes must fit 2,096,128 bytes. The timestamp reservation also covers extended-year ISO strings.
- Projection: workspace + slug + generation + the actual serialized projection JSON must fit the same bound. `TextEncoder` counts UTF-8 bytes after JSON escaping. Raw source text is counted as SQL text, without incorrectly charging its HTTP JSON escapes to its SQL field.

The remaining 1 KiB below 2 MiB reserves SQLite record-header space. Exact current-year saves use three fewer timestamp bytes than reserved. For workspace `summaries`, slug `summary` and a 64-byte revision, the maximum permitted new source identity is 2,095,985 UTF-8 bytes. One byte above that rejects with an actionable source-metadata error before artifact writes. UTF-16 character count is not the contract.

Backfill does not apply the new pointer publication bound to existing accepted pointers and does not rewrite them. Their separately stored graph projection fits without adding bytes to the old pointer row. The workerd tests prove both the old 1,100,001-byte source and a 2,096,428-byte source remain readable with an exact 1 MiB graph. The latter exceeds the new conservative publication bound: a new same-body save rejects with zero R2 writes, while the old summary remains warm and readable. Republish with a shorter source identity if such an old pointer needs a new publication.

Warm summary, list and run metadata paths still make zero R2 graph reads, including after actual object eviction. Full get/start/schedule still validate their selected graph. Existing service grouped-count behavior, global aggregation, native absence errors and metadata caching were not changed by this correction.

## Focused checks

All final generated test state is fresh under `.loopy/architecture-tests`. The evidence directory is `.loopy/architecture-tests/summary-p2-cmrw519a`. New size fixtures additionally create their own fresh `summary-size-*` directories there and dispose them. No legacy Registry fixture was run after the incident was identified.

Final safe suite:

```sh
TMPDIR="$PWD/.loopy/architecture-tests/summary-p2-cmrw519a" WRANGLER_SEND_METRICS=false bun --no-env-file test --timeout 60000 packages/loopy/_tests_/definition-summary-size.test.ts packages/loopy/_tests_/definition-summaries-workerd.test.ts packages/loopy/_tests_/definition-summaries-service.test.ts packages/loopy/_tests_/cloud-artifacts.test.ts packages/loopy/_tests_/cloud-service.test.ts packages/loopy/_tests_/architecture.test.ts
```

Result: **38 pass, 0 fail, 315 assertions** across six files. Log: `final-focused-tests.log` in the evidence directory. The seven new size cases prove legacy readability, maximum-size graph metadata, raw-source escaping and multibyte handling, exact publication budget acceptance, pre-R2 rejection, projection contents without duplicate pointer metadata, unchanged legacy generation/savedAt and zero warm graph reads. The existing focused cases retain source ownership, quota races, cold save races, rollback, missing/corrupt artifact errors, same-save repair, global counts, native typed absence, SSE, portable bundling and layer boundaries.

Typechecks, both exit zero without diagnostics:

```sh
bunx tsc --noEmit --pretty false -p packages/loopy/tsconfig.portable.json
bunx tsc --noEmit --pretty false --target ES2022 --lib ES2022,DOM,DOM.Iterable --module ESNext --moduleResolution Bundler --strict --noUncheckedIndexedAccess --verbatimModuleSyntax --skipLibCheck --types bun-types packages/loopy/_tests_/definition-summary-size.test.ts packages/loopy/_tests_/definition-summaries-workerd.test.ts
```

Scoped lint and formatting, both exit zero:

```sh
bunx eslint apps/cloud/src/artifacts-definitions.ts apps/cloud/src/artifacts-projection.ts apps/cloud/src/artifacts-storage.ts apps/cloud/src/artifacts-validation.ts packages/loopy/_tests_/definition-summaries-workerd.test.ts packages/loopy/_tests_/fixtures/summary-workerd.ts packages/loopy/_tests_/definition-summary-size.test.ts packages/loopy/_tests_/fixtures/summary-size-body.ts packages/loopy/_tests_/fixtures/summary-size-runtime.ts packages/loopy/_tests_/fixtures/summary-size-workerd.ts
bunx biome check apps/cloud/src/artifacts-definitions.ts apps/cloud/src/artifacts-projection.ts apps/cloud/src/artifacts-storage.ts apps/cloud/src/artifacts-validation.ts packages/loopy/_tests_/definition-summaries-workerd.test.ts packages/loopy/_tests_/fixtures/summary-workerd.ts packages/loopy/_tests_/definition-summary-size.test.ts packages/loopy/_tests_/fixtures/summary-size-body.ts packages/loopy/_tests_/fixtures/summary-size-runtime.ts packages/loopy/_tests_/fixtures/summary-size-workerd.ts
```

ESLint had no diagnostics; Biome checked ten files with no fixes. Logs are `portable-typecheck.log`, `targeted-typecheck.log`, `eslint.log`, and `biome.log`. Scoped diff whitespace checks also passed. The original inline-column assertion was changed to assert the separate table; no lifecycle test was deleted or moved. New production files remain below 250 lines. No casts or `any` were added.

## Causal controls

Four mutations failed with exit 1 and were restored in `finally` before the final green suite. Commands used `bun --no-env-file test --timeout 60000` with the listed file/filter and the same isolated environment. `negative-controls.json` records commands and sanitized failure summaries; `controls/` holds only the nonpersonal focused logs.

| Mutation | Test file and filter | Result |
| --- | --- | --- |
| Put projection JSON plus duplicated source back on the pointer row | `definition-summary-size.test.ts -t 'legacy 1100001-byte'` | Actual workerd `SQLITE_TOOBIG`; old accepted metadata becomes unreadable |
| Remove pre-R2 row validation | `definition-summary-size.test.ts -t 'one-byte-over'` | Two artifact writes occur instead of the required zero |
| Count JavaScript code units instead of UTF-8 bytes | `definition-summary-size.test.ts -t 'multibyte-over'` | Native `SQLITE_TOOBIG` after two artifact writes, instead of early rejection |
| Remove the generation and already-present repair fence | `definition-summaries-workerd.test.ts -t 'against a valid old graph'` | A stale backfill overwrites the winning save's metadata |

## Native-fixture incident and integration dependency

An optional wider rerun attempted the previous ten-file 73-test set with TMPDIR inside the required fresh workspace-local directory. Older `service-input.test.ts`, `service.test.ts` and `registry.test.ts` fixtures construct Registry before creating a local project marker. Their upward project search reached the real home registry. That caused personal registry reads and three accidental synthetic registry writes. This was outside the requested isolation boundary. The wider run ended with 50 passes and 23 failures and is not passing acceptance evidence.

Root was notified immediately after diagnosis and stopped its integrated check. I made no direct home cleanup reads or writes after discovery. Root owns provenance-checked cleanup of the three synthetic files and the fixture-isolation fix. No personal registry payload is reproduced here. At root's instruction the payload-bearing `tests.log` was deleted without a copy. Only its SHA-256, byte count and failure count remain in `sanitized-incident.json`: SHA-256 `c5cb5d9f5d04e20728c33c604f539e721cb80d932a82de0f9e7f137acb0de7ca`, 214,688 bytes, 23 failed tests. Final safe checks exclude those older fixtures. Broad integration acceptance depends on root's isolation fix and rerun.

## Limits and stable source receipt

These checks cover synthetic local workerd/R2 and the stated focused source boundaries. They do not accept remote deployment, production migration, workloads, latency or unbounded publication churn. No fullcheck was run by this lane. Old unpublished inline-column data gets no compatibility path. All original source/test files outside the ten listed below are unchanged by this P2 repair. Shared schema 15 is untouched.

The table compares against the independently reviewed source snapshot at the start of this repair. The stable manifest is SHA-256 over each sorted path, a NUL, its after-hash and a newline. It excludes this note to avoid a recursive hash. Manifest SHA-256: `95741a267fc8fb96d836ebb43f617a9b2f25fcc74117cf4324933f5b873f6bf5`.

| File | Added | Deleted | SHA-256 |
| --- | ---: | ---: | --- |
| `apps/cloud/src/artifacts-definitions.ts` | 57 | 39 | `52845c7bd1427297858c169a7a8134974eb55485014d00314b2c8f057cbfdf9c` |
| `apps/cloud/src/artifacts-projection.ts` | 65 | 0 | `6aca5df479acafb31544945c1413291fa5c0784bc15734e816d77cf2595cf657` |
| `apps/cloud/src/artifacts-storage.ts` | 2 | 0 | `67e26b2428669d2f794eb33e115ac129d40cdbc469c71282ab18f7b8c4c3cdf5` |
| `apps/cloud/src/artifacts-validation.ts` | 3 | 0 | `aa1e730f5ba93bcec808b44b16c6871765e66cf1413bbe5b5dadf694c9c22cd0` |
| `packages/loopy/_tests_/definition-summaries-workerd.test.ts` | 17 | 6 | `1948881c8d680719ff485261b9153687424ed73c38a46bfb609fa3a7a4814a0c` |
| `packages/loopy/_tests_/definition-summary-size.test.ts` | 175 | 0 | `8f5a8306c4b37983b30ea286417e0e478d8ac86e0c6f7249bbfdd230ff552ed0` |
| `packages/loopy/_tests_/fixtures/summary-size-body.ts` | 31 | 0 | `d61df712cd76f06e34f8a214c09078d480752c056410da208f558288960bdd7a` |
| `packages/loopy/_tests_/fixtures/summary-size-runtime.ts` | 64 | 0 | `cdb6d48f98409ba2eb621cb9fad3703f19b5d4f81728a4dfba58b515618ef0fc` |
| `packages/loopy/_tests_/fixtures/summary-size-workerd.ts` | 162 | 0 | `67c971203edf3f70191d706cae18dc98b2fb62de7fa5899ef830980b81cf9eb7` |
| `packages/loopy/_tests_/fixtures/summary-workerd.ts` | 9 | 3 | `7f7c302fccbf696a868c6d487b5de1a3fd925d1ec97eb357aa65d975e2bdc480` |
