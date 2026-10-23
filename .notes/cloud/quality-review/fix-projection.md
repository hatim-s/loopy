# Projection correction

Implemented the projection decision in TRIAGE.md and runtime-data-opus finding 4 after reading both paired runtime-data reports. Starting branch was `cloud-integration`, HEAD `9d30ca923d168e299099758e0d95f3db3ba81cf0`. No commits or pushes were made.

## Changes and behavior

- `apps/cloud/src/artifacts-projection.ts`: the serializer literal now uses `satisfies DefinitionProjection`. TypeScript checks the inferred field values and required-field completeness before JSON.stringify. No casts, runtime parsers or revalidation were added.
- `packages/loopy/src/contract/definition-summary.ts`: added `definitionInput`, typed from the existing graph schema through `Graph`. Summary formatting and cloud preflight now share this rule. The summary caller deliberately supplies `saved.input` alongside graph input-validation metadata, preserving the previous behavior even when a typed saved record contains different graph and saved input metadata.
- `packages/loopy/src/contract/index.ts`: added only the `definitionInput` export beside the existing summary exports.
- `packages/loopy/_tests_/definition-summary-size.test.ts`: retained all seven existing size tests and added one workerd publication case for a JSON root with a large optional multibyte JSON field hint. It checks successful publication, the displayed schema input and exact persisted projection bytes. No dedicated projection unit-test file or permanent compile-negative test was added.

There is no intended runtime behavior change. Serialization remains scope, description, input, schedule, mode in that order, with the same JSON.stringify bytes. UTF8 row checks still precede artifact writes. Legacy large-source reads, maximum graph reads, schema parsing of stored projections, source ownership, generation fences and publication transactions remain unchanged. Missing a required serializer field now fails compilation instead of producing an unreadable stored projection after a future schema edit.

No edits crossed assigned ownership. Artifact definitions, artifacts.ts and shared workerd harness files were left to their owners. All other checkout changes belong to sibling lanes.

## Focused verification

Tests ran from a fresh source snapshot at `.loopy/quality-tests/projection-rp5gs7ap/snapshot`. The snapshot copied current package source, cloud source, fixtures and the three selected test files. Its `.loopy/loopies` marker stopped ancestor registry lookup. Only dependencies were symlinked from the checkout.

The child Bun process received a fresh environment containing PATH, HOME, LOOPY_HOME, XDG_CONFIG_HOME, XDG_CACHE_HOME, XDG_DATA_HOME, TMPDIR, CI=1, WRANGLER_SEND_METRICS=false and DO_NOT_TRACK=1. Every home/cache/temp path was inside this unique disposable root. TMPDIR applied only to these three cloud tests, never globally or to legacy sandbox tests. Bun used `--no-env-file`.

Two harness adjustments existed only in the disposable copy: the old summary-size runtime parent changed from `.loopy/architecture-tests` to `.loopy/quality-tests`, and cloud-artifacts Miniflare received host 127.0.0.1 and port 0. The other selected runtimes already used port 0. No existing services, Docker, cloud APIs, personal state or historical datasets were used. Test runtimes disposed themselves. The owned disposable root was removed after recording results.

Commands and results:

```sh
node_modules/.bin/biome check packages/loopy/src/contract/definition-summary.ts packages/loopy/src/contract/index.ts apps/cloud/src/artifacts-projection.ts packages/loopy/_tests_/definition-summary-size.test.ts
```

Final result: exit 0, `Checked 4 files in 3ms. No fixes applied.` Initial formatting/import-order findings were fixed, then checked again.

```sh
node_modules/.bin/eslint packages/loopy/src/contract/definition-summary.ts packages/loopy/src/contract/index.ts apps/cloud/src/artifacts-projection.ts packages/loopy/_tests_/definition-summary-size.test.ts
```

Final result: exit 0, no output. Initial readable-spacing findings in the added test were corrected.

```sh
node_modules/.bin/tsc --noEmit -p .loopy/quality-tests/projection-rp5gs7ap/tsconfig.projection.json
```

The disposable config extended the copied root tsconfig, set include/exclude to empty lists, and selected only definition-summary.ts, artifacts-projection.ts and definition-summary-size.test.ts plus their imported dependencies. Positive check: exit 0, no output. Compile negative control: removed mode only from the disposable serializer literal. The same command exited 2 with TS1360 and `Property 'mode' is missing`. Restored the literal and reran: exit 0, no output. Shared production source was never mutated for this control.

The disposable runner invoked these exact child commands with the environment above and cwd set to the snapshot:

```sh
bun --no-env-file test --timeout 60000 packages/loopy/_tests_/definition-summary-size.test.ts
bun --no-env-file test --timeout 60000 packages/loopy/_tests_/definition-summary-size.test.ts packages/loopy/_tests_/definition-summaries-workerd.test.ts packages/loopy/_tests_/cloud-artifacts.test.ts
```

Size-only final result: exit 0, 8 pass, 0 fail, 51 assertions. The first attempt at the added fixture used invalid JSON-root hints and reject semantics; corrected it to optional JSON hints with passthrough before the successful runs.

Combined final result: exit 1, 24 pass, 2 fail, 229 assertions. All size tests and the existing legacy repair, replacement-generation race and SQL rollback tests passed. Two outstanding failures match the sibling service lane's intentional direct registry absence change:

- `definition-summaries-workerd.test.ts:219`: the absent direct get operation returns status 200 with `{value:null,graphReads:0}`. The assertion still expects status 400 and code not_found. Root should coordinate the get-only null assertion with the harness owner, while preserving start/schedule service not_found checks.
- `cloud-artifacts.test.ts:361`: get of unpublished definition-41 returns status 200 with `{value:null}`. The assertion still expects status 400. Root should coordinate this direct-registry expectation with the service lane.

Those tests and their harnesses are outside this lane and were not edited here. The combined run is not claimed green. Root owns integration and fullcheck. No broad check or build was run.

```sh
git diff --check -- apps/cloud/src/artifacts-projection.ts packages/loopy/src/contract/definition-summary.ts packages/loopy/src/contract/index.ts packages/loopy/_tests_/definition-summary-size.test.ts
```

Result: exit 0, no output.

## Size and handoff

Compared with starting HEAD, production source is +16/-3 lines across the three assigned source files. The existing test file is +24/-1 lines. Total code and test delta is +40/-4 lines. No tests were moved or deleted. The added helper and explicit serializer formatting account for the small source increase; no generic framework was introduced.

SHA256 of the final owned source and test files, verified byte-identical to the final tested snapshot:

```text
50c9c55321ddf22ea1002d23ca590b94edc7bec664ca3aa18fe291156e03470a packages/loopy/src/contract/definition-summary.ts
440f1ade58b5276135785997287649ae1721cbbf2591fb03e4f56fa0dcf011a1 packages/loopy/src/contract/index.ts
5c4aed5cc471d79d12402ee3c5ed20c1556a436c29413d6fbf2ede7c2012734e apps/cloud/src/artifacts-projection.ts
7819ed37d02f7e87393ce659abc0b81a50ba24e78c57b08a108f9242ee5a8eb4 packages/loopy/_tests_/definition-summary-size.test.ts
```

No further source edits after this handoff. Optional artifactEntry relocation was deferred because it crosses ownership and is unnecessary for field completeness or input-rule sharing. Persisted legacy support and historical evidence were retained.
