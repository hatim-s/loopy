---
title: Independent data and service round-2 review
status: approved in reviewed scope
date: 2026-10-23
base: 6ffecdfd60e16aaa335467684d918b3cd8b44813
branch: cloud-integration
---

# Verdict

Approve the pinned data and service candidate. Round 1's P2 is fixed. No additional blocking finding emerged from the changed storage layout, publication transaction, backfill fencing, byte limits or old-data semantics.

This is an independent second round against dirty source above HEAD `6ffecdfd60e16aaa335467684d918b3cd8b44813`, on `cloud-integration`. The review follows AGENTS.md, unslop, pr-review and the TypeScript review guidance. The original lane is a major refactor with the expressly bundled scope correction and summary feature. This round reviews its minor bug fix. The user has already settled the combined scope and always-separate table layout; no PR split or conditional-overflow design is requested.

The only repository report written by this reviewer is this file. Disposable scripts, logs and synthetic persistence are in the fresh evidence directory below. No production or existing test source was edited. No commits, delegation, old database/API access, services, Docker, remote cloud, credentials or main operations occurred. The separately running Docker proof was left alone.

# P2 closure and changed behavior

`apps/cloud/src/artifacts-definitions.ts:34-43` retains the six-column pointer and creates cloud-only `artifact_definition_summaries`, keyed by workspace and slug. Each projection carries its publication generation. Both pointer queries join on workspace, slug and generation. `summary()` reconstructs slug, revision, source and savedAt from the pointer and parses only scope, description, input, schedule and mode from the projection.

Production cloud source contains no `summary_json` column, read or write. Source metadata is no longer duplicated in a stored pointer row or projection. The separate table is justified by the reproduced row limit, even though the earlier proposal preferred an inline column when ALTER was available. Shared schema 15 and portable initialization have no diff from HEAD.

Independent actual-workerd tests passed for legacy source paths of 1,100,001 and 2,096,428 UTF-8 bytes, each paired with an exact 1,048,576-byte graph. Cold summary, list and service metadata remain readable. Pointer identity is preserved, and warm summary/list/service access, including after DO eviction, reads zero R2 graphs. The joined SQL result can contain both large fields without reproducing the stored-row failure.

New publications have a conservative per-row payload budget of 2,096,128 UTF-8 bytes, reserving 1,024 bytes below 2 MiB for SQLite record overhead. `artifacts-projection.ts:45-64` counts pointer strings plus 36 generation bytes and up to 27 timestamp bytes. It independently counts the serialized projection, including JSON escaping, workspace, slug and generation. `checkArtifactLimits()` calls this before validation/storage work or any R2 operation.

ASCII, NUL/quote/backslash escaping and emoji inputs passed at the conservative pointer boundary alongside maximum-size graphs. One-byte-over and multibyte overflow return the explicit metadata budget error with zero artifact reads or writes and no pointer. Source strings are measured as raw UTF-8 SQL text; projection JSON is measured after serialization. Those are the bytes each stored row actually contains.

The new publication bound also applies to identical saves. An already accepted legacy pointer above that conservative bound remains readable and can backfill its projection, but saving that body again is rejected before R2 access. The legacy test verifies that rejection leaves the readable warm summary intact. Backfill writes only the separate projection and does not rewrite the pointer. This is the intended distinction between preserving published data and limiting new writes.

# Publication and backfill safety

`ArtifactDefinitions.publish():140-187` retains the synchronous SQL transaction around the owner/generation recheck, capacity accounting, pointer and projection. A changed publication creates a new generation; an identical publication repairs missing or malformed derived metadata without changing savedAt or generation. A byte-identical projection retains the early return.

The regular workerd suite verifies rollback after the transaction callback, source-owner races and competing aggregate-capacity publications. My additional workerd probe puts a real CHECK constraint on the projection table and fails the projection INSERT after the pointer and graph-size writes. Pointer, previous projection and graph-size rows all remain exactly unchanged. The previous summary stays readable. Two immutable R2 writes may remain unreferenced after the failed SQL publication, as before.

`repair():118-129` rereads the generation inside its transaction and writes only when the matching projection is absent. R2 reads, graph parsing and revision hashing stay outside SQL transactions. Existing workerd race tests passed for valid, missing and corrupt old graphs while a replacement save wins. The resolver returns the winning summary instead of a stale result and retains its finite retry/read budget.

My second probe replaces the projection with malformed JSON under a stale generation. The generation-matched join treats it as absent. Backfill replaces it with the current generation using one graph read, keeps the pointer unchanged, and the next read uses zero graphs. This verifies the separate-table join's absence semantics directly.

Malformed JSON for the current generation remains a storage error until a save repairs it. Cold missing/corrupt graphs still fail without a partial successful list. Warm metadata may remain readable after out-of-band graph corruption; direct get, start and schedule still load and validate that graph. True absence remains null for summary and typed not_found for direct lookup.

# Independent verification

Fresh evidence directory:

`/Users/hatim.shakir/projects/loopy/cloud-integration/.loopy/architecture-tests/data-review-2-4r69he5x`

Exact focused command, with `reviewDir` set to that absolute path:

~~~sh
TMPDIR="$reviewDir" WRANGLER_SEND_METRICS=false bun --no-env-file test --timeout 60000 packages/loopy/_tests_/definition-summary-size.test.ts packages/loopy/_tests_/definition-summaries-workerd.test.ts packages/loopy/_tests_/definition-summaries-service.test.ts packages/loopy/_tests_/cloud-artifacts.test.ts packages/loopy/_tests_/cloud-service.test.ts
~~~

Result: **35 pass, 0 fail, 311 expect calls**, across five files. Log: `focused-tests.log`. The seven size tests and the workerd summary/artifact suites run real local workerd SQL and R2. The service suite also checks typed absence, version-1 skipping, version-2 corruption and malformed native JSON using fresh synthetic homes.

~~~sh
TMPDIR="$reviewDir" WRANGLER_SEND_METRICS=false bun --no-env-file "$reviewDir/independent-probes.ts"
~~~

Result: exit 0, two explicit passing records in `independent-probes.log`. The scripts, built worker and fresh durable/R2 state are confined to this directory. CHECK failure was injected into disposable storage; production source was not mutated.

Scoped `git diff --check` passed with no output for the changed artifact modules and summary tests/fixtures. Shared `schema.ts`, `store-schema.ts`, `query-schema.ts` and `portable.ts` have no diff from HEAD.

Compared with the round-1 report's exact hash table, only artifacts-definitions.ts, artifacts-storage.ts, artifacts-validation.ts and definition-summaries-workerd.test.ts changed. The new projection module, size suite and fixtures were reviewed too. Grouped-count, scope pagination, summary contracts, service extraction and native adapter hashes in that table remain unchanged. Their full earlier analysis was not reopened; the focused service/artifact suites were rerun because they call the changed code.

The 27-file summary source/test inventory pinned here is **+2355 / -723** against HEAD, including previously reviewed extraction work. This reviewer added no source changes and deleted or moved no tests. Counts and scope implementations retain the round-1 conclusions at their unchanged hashes.

Read proposal.md, fable-review-1.md, data-review-1.md and summaries-implementation.md. At this pin, summaries-implementation.md still describes the round-1 inline-column implementation; the brief says its P2 update is in progress. Its earlier check results and the author's reported four restored causal mutations were not counted as independent round-2 evidence. The source and checks above determine this verdict.

# Exact pin and limits

`source-start.json` and `source-final.json` pin 42 reviewed source, test and design-note files. All 42 were unchanged through the checks and final verification. SHA-256 of `source-final.json` is `70e100d35bb446c34934d2af43f6dac3ca167b34eab922c02f598957a8eabd2e`. `evidence-hashes.json` pins the manifests, scripts and logs.

The main changed implementation and test hashes follow. The full manifest also pins unchanged dependencies and shared-schema files.

| File | SHA-256 |
| --- | --- |
| apps/cloud/src/artifacts-definitions.ts | 52845c7bd1427297858c169a7a8134974eb55485014d00314b2c8f057cbfdf9c |
| apps/cloud/src/artifacts-projection.ts | 6aca5df479acafb31544945c1413291fa5c0784bc15734e816d77cf2595cf657 |
| apps/cloud/src/artifacts-storage.ts | 67e26b2428669d2f794eb33e115ac129d40cdbc469c71282ab18f7b8c4c3cdf5 |
| apps/cloud/src/artifacts-validation.ts | aa1e730f5ba93bcec808b44b16c6871765e66cf1413bbe5b5dadf694c9c22cd0 |
| apps/cloud/src/artifacts.ts | 9ce6fe605e0b844b9777adebf5585685eee76624be25bfa94af6059a5803d621 |
| apps/cloud/src/artifacts-capacity.ts | ff5e583220fb88e00c017be1dafb44e0a00ed555f817f3762cc0f8ffe33da2b5 |
| packages/loopy/_tests_/definition-summaries-workerd.test.ts | 1948881c8d680719ff485261b9153687424ed73c38a46bfb609fa3a7a4814a0c |
| packages/loopy/_tests_/definition-summary-size.test.ts | 8f5a8306c4b37983b30ea286417e0e478d8ac86e0c6f7249bbfdd230ff552ed0 |
| packages/loopy/_tests_/fixtures/summary-workerd.ts | 7f7c302fccbf696a868c6d487b5de1a3fd925d1ec97eb357aa65d975e2bdc480 |
| packages/loopy/_tests_/fixtures/summary-size-body.ts | d61df712cd76f06e34f8a214c09078d480752c056410da208f558288960bdd7a |
| packages/loopy/_tests_/fixtures/summary-size-runtime.ts | cdb6d48f98409ba2eb621cb9fad3703f19b5d4f81728a4dfba58b515618ef0fc |
| packages/loopy/_tests_/fixtures/summary-size-workerd.ts | 67c971203edf3f70191d706cae18dc98b2fb62de7fa5899ef830980b81cf9eb7 |

This approves the reviewed hashes, not future edits or the integration tree. No fullcheck, broad lint/typecheck, copied-data opening, native schema-13/14 upgrade rerun, workload/latency claim, Docker proof, deployment or main acceptance is supplied here. Those gates remain root-owned and are not source defects. The storage budget remains a conservative publication bound, not a claim that every possible workerd/SQL limit has been modeled.
