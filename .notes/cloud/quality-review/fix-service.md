# Service quality correction

Implemented against branch `cloud-integration`, starting HEAD `9d30ca923d168e299099758e0d95f3db3ba81cf0`. Read `AGENTS.md`, both runtime-data reviews, `TRIAGE.md`, `unslop`, and TypeScript craft with its architecture, tests and TypeScript references. Code supplied the implementation facts. No memory-derived code claims.

## Changes and behavior

- `local/LoopyService` now subclasses the portable service. Its constructor still takes `{ store, registry, clock }`. The local file only supplies native registry, secrets, workspace and type-generation adapters. Removed its duplicate graph/secret methods and all local forwarding methods. Portable schedules, queries, mutations and run views remain separate owners.
- Local direct calls to `graph`, `listSecrets`, `putSecret` and `deleteSecret` now return promises. Their failures reject instead of throwing synchronously. Updated all discovered synchronous graph test callers to await results or rejected promises. Routes use the portable service type directly; removed `AwaitableMethods`. No compatibility forwarding path remains.
- `ArtifactRegistry.get` returns `Promise<SavedLoopy | null>`. Native adapters convert only `RegistryMissingError` to null. Cloud adapters return null only when the definition pointer is absent. JSON, schema, immutable graph verification and storage errors propagate.
- `service/definition.ts` owns `requireDefinition`. Start, current graph, source and all definition-dependent schedule mutations use its one `ServiceError("not_found")` translation and existing user message. Six missing routes return 404 in both native HTTP and portable cloud routing. Corrupt native entries remain HTTP 500. Actual workerd get/start/schedule corruption checks still fail as storage errors.
- Cloud scheduling explicitly rejects a missing current definition inside the existing per-schedule catch. The schedule stays enabled, writes the existing five-second retry deadline, does not create a run and does not block healthy schedules. Restoring a definition lets the due schedule retry and pin the restored revision. Later saves do not rewrite the resulting run revision. Store fire/version/owner behavior is unchanged.
- Removed the dead `SummaryCountsStore.runCounts` override in coordination with the query lane. Kept the grouped-read assertion and documented the scale property it protects.
- Direct registry test probes now return HTTP 200 with `body.value: null` for absence. These probes are adapter test endpoints, not external service routes. Start and schedule probes retain `not_found`. Corruption assertions are unchanged.

The type-only `ServiceMutations` dependency on the facade remains. Its three methods include pinned graph reads and run-not-found handling. There is no existing narrower concrete owner for all three; replacing it here would add callback contracts or duplicate those behaviors. The local runtime facade and mapped awaitability type were removed without that extra refactor.

## Ownership and delta

No edits to query/store owners, projection/definition/validation/storage owners, contract summary ownership, workerd harnesses, AGENTS or READMEs from this lane. Root granted exclusive `cloud-scheduler.test.ts` edits, then surgical absent-get assertions in `cloud-artifacts.test.ts` and `definition-summaries-workerd.test.ts`. The latter file also has sibling harness edits; this lane owns only its six added and one deleted assertion lines. All discovered outside caller changes were reported before editing. No remaining outside-file edits are required.

Production source delta is **47 lines added, 139 deleted, net -92**, including the new 15-line definition helper. Local service alone is 13 added and 120 deleted. Test/fixture delta owned by this lane is 100 added, 30 deleted, including the assertion-only share of the workerd file. No test was moved or deleted. The only removed test method was the unused `runCounts` override, since the query lane removed that contract.

## Validation

All test state was fresh under `.loopy/quality-tests/service-jpabmzi8`. Tests ran from disposable copies with the real source linked in, explicit project markers, injected per-fixture homes and a sanitized process environment containing only PATH, HOME, XDG directories, LOOPY_HOME, NO_COLOR and, for Miniflare, disabled Wrangler metrics. Temp-root expressions were redirected only in disposable test copies. Global TMPDIR was never set. Native servers used port 0. The legacy artifact Miniflare copy explicitly used loopback and port 0. The shared probe harness already does so. No cloud calls, Docker, existing-service actions, personal state or historical datasets were used.

Final successful commands, run from the disposable test root unless noted:

```sh
bun --no-env-file test --timeout 60000 ./packages/loopy/_tests_/service.test.ts ./packages/loopy/_tests_/cloud-service.test.ts ./packages/loopy/_tests_/cloud-scheduler.test.ts ./packages/loopy/_tests_/definition-summaries-service.test.ts ./packages/loopy/_tests_/registry.test.ts ./packages/loopy/_tests_/registry-isolation.test.ts ./packages/loopy/_tests_/secrets.test.ts
```

Printed **52 pass, 0 fail, 377 expect calls**, seven files, 594 ms. Covers input-before-write, pinned revisions, lease/cancellation fences, schedule concurrency, SSE transactions, grouped reads, native corruption boundaries, ancestor isolation, and actual CLI secret CRUD.

```sh
bun --no-env-file test --timeout 60000 ./packages/loopy/_tests_/server.test.ts -t 'native definition routes|schedule routes round trip|compiled save route|service error codes|API distinguishes invalid'
```

Printed **5 pass, 0 fail, 19 filtered, 94 expect calls**, 660 ms. Covers six missing routes and six corrupt routes, route error codes, schedules, registry failure handling and compiled artifact publication. The test selection does not claim full server-suite coverage.

```sh
bun --no-env-file test --timeout 60000 ./packages/loopy/_tests_/cloud-artifacts.test.ts ./packages/loopy/_tests_/definition-summaries-workerd.test.ts
```

Printed **18 pass, 0 fail, 195 expect calls**, two files, 2.91 s. This combined run includes both final nullable assertions, real local R2/DO SQL behavior, corruption distinctions, ownership races, generation fences and capacity rejection. Projection lane's earlier absent-get failures are resolved.

Commands run from the actual checkout:

```sh
bunx tsc -p .loopy/quality-tests/service-jpabmzi8/tsconfig.focused.json
bunx eslint packages/loopy/src/local/service.ts packages/loopy/src/service/{definition,service,registry,queries,schedules,routes}.ts apps/cloud/src/{artifacts,scheduler-schedules}.ts packages/loopy/_tests_/{service,server,cloud-service,cloud-scheduler,definition-summaries-service,cloud-artifacts,definition-summaries-workerd}.test.ts packages/loopy/_tests_/fixtures/summary-service.ts
bunx biome check packages/loopy/src/local/service.ts packages/loopy/src/service/{definition,service,registry,queries,schedules,routes}.ts apps/cloud/src/{artifacts,scheduler-schedules}.ts packages/loopy/_tests_/{service,server,cloud-service,cloud-scheduler,definition-summaries-service,cloud-artifacts,definition-summaries-workerd}.test.ts packages/loopy/_tests_/fixtures/summary-service.ts
```

TypeScript and ESLint exited 0 without diagnostics. Biome printed `Checked 17 files in 10ms. No fixes applied.` The temporary tsconfig extends the repository tsconfig and limits roots to local/service.ts, service/**/*.ts, the two owned cloud sources, and the seven changed test files. Transitive imports were typechecked. No broad check was run. Initial scoped lint found three spacing issues; fixed and reran successfully.

Negative control:

```sh
bun --no-env-file test ./packages/loopy/_tests_/cloud-service.test.ts -t 'portable routes'
```

Only a detached disposable production-source copy was mutated. Changing the helper's absent-definition error from `not_found` to `internal` produced the expected **1 fail**, exit 1, `Expected: 404`, `Received: 500`. Restored that detached file afterward. Shared production source was never mutated for a negative control.

Two test setup problems preceded the final native pass. Compiler restrictions rejected SDK paths going through a disposable source symlink; a temporary full source copy then lacked package-local parser resolution. The final run used real source links and canonical SDK paths in disposable tests. Neither required a production or checked-in fixture change. Full final output and negative-control output are in `fix-service-checks.txt`.

Disposable test state was removed after preserving the results. No commits or pushes. Root retains integration and full-check ownership. Source is stable for follow-up review.
