# Tooling and docs review, round 2

Verdict: **approved**. Both original blockers are fixed. The PROBES consolidation keeps the old binding, persistence and eviction semantics. The docs match current code on modes, authority, recovery and service boundaries. Nothing below weakens a durable guarantee. Two doc edits (D1, D2) are worth making before commit because this diff introduced the duplication they fix. The rest are optional.

Static review only. I ran no tests, builds, lint, typecheck, services, Docker or cloud calls, and I edited no source. I wrote only this file.

## Scope and pins

HEAD `9d30ca923d168e299099758e0d95f3db3ba81cf0`, uncommitted diff against HEAD. SHA-256 of the reviewed working-tree files:

| File | SHA-256 |
| --- | --- |
| packages/loopy/_tests_/workspace-read-queue.test.ts | 1e45325e7505457eb73abeb10f8d0cf1a8491154406e94a8a90a12b5bbf48c13 |
| packages/loopy/_tests_/fixtures/workspace-read-queue-provider.ts (unchanged) | 0a445a692f88a4c92e09d9e1a5fe8df5f3002e1309a37c5ed598bba50015621f |
| packages/loopy/_tests_/definition-summaries-workerd.test.ts | a2f727ebb96d8eb3b02f4337cbbc5db9739848e96df5378aa2f7f57e0b8e32d2 |
| packages/loopy/_tests_/readmodel-workerd.test.ts | 5db97843498059537092ed56873ea04384d937d29b55c48a21bb551231eb2877 |
| packages/loopy/_tests_/fixtures/summary-size-runtime.ts | 472270ac2fe226101b38e0b0e9428806f0678ffae58c25017186dc830abfe249 |
| packages/loopy/_tests_/fixtures/workerd-probe.ts (new) | 7e2bdd8194ead9ebc95bc627cf359f6dda61ff34d53d468c58adb8a5686b3178 |
| packages/loopy/_tests_/fixtures/quality-test-root.ts (new) | 747b91f1ce80366094b73da7291c010a28e486c7b7f1e99b81b0150f8b7f0fbc |
| AGENTS.md | a15c28873e5495997ee8ebbce55029f41fabb3a9459039eafa248a247e166b9e |
| CONTRIBUTING.md | f7a7612584117743976f7b3dd2531a6d512701a2fa2fd08c62e50f02d19b1d70 |
| apps/cloud/README.md | 2d73f1d0232ddf74124448b6a800fd06b3ee97b0853d49aa3429513ed67a399b |
| apps/sandbox/README.md | 2eb7006609ea311f0484c744e61365ed9595bd5cf3da5a20a283c6099a128f76 |

Read first: AGENTS.md, unslop, pr-review, typescript-codebase-craft. Then the source and its callers. Only after that: tests-tooling-sol.md, tests-tooling-opus.md, TRIAGE.md, fix-test-upkeep.md and fix-docs.md.

Classification: minor refactor of test tooling plus documentation correction. The two kinds of change are separable, but both fall under the triaged quality pass, so I don't treat the mix as a blocker.

## What I verified

**Freeze removal.** The test no longer reads `source-freeze.json`, and the 467-file, aggregate and before/after comparisons are gone. `rg source-freeze packages apps scripts` finds nothing. Every behavioral assertion is still present and unchanged at `workspace-read-queue.test.ts:116-181`: the control-workspace read during the hold, no held-tenant headers before release, release reason, run/loopy/history results, the snapshot status, a single admission and lookup, and an empty error list. The `zod` import went with the freeze schema. `createHash` and `readFile` are still used for the diagnostic bundle hash at line 62.

**Success cleanup.** The test runs `rm` at line 208 only after every per-mode `finally` (lines 187-196) has released the provider, disposed Miniflare and closed the provider server. A failure writes `evidence.json` and prints the path, then rethrows the original cause. The explicit `modulesRoot` at line 71 matches the cwd fix the upkeep report describes.

**PROBES helper semantics** (`workerd-probe.ts`), compared field by field against the three HEAD copies:

- Build: same `target`, `format` and `naming`. Startup now fails on a non-empty log array as well as on `!success`. The two tests already asserted `logs == []`, so only `summary-size-runtime` got stricter, and that is intended.
- Miniflare: same host, port 0, modules, compatibility date, `PROBES` with `useSQLite: true` and `durableObjectsPersist: <dir>/durable`. R2 gets `["BUCKET"]` plus `r2Persist` only when `r2` is set. The read-model runtime still has no R2 binding, as at HEAD.
- Eviction: `unsafeEvictDurableObject(options.name, options.className, { name })` uses the same worker name and class as the HEAD literal in `summary-size-runtime`.
- Requests: no body sends a GET to `http://probe<path>`, which matches the HEAD read-model call. A body sends a POST of the JSON to `http://probe/`, matching both summary copies. The response is parsed as `unknown`, and each caller still parses it with its own schema.
- Teardown: if startup fails, the helper disposes any runtime it constructed and then removes the directory in a `finally`. `cleanup()` uses the same dispose-then-remove `finally`. Callers use `harness?.cleanup()`, so a failed `beforeAll` doesn't throw a second time.
- Size: an 83-line function with four typed options and one closure-returned object. It doesn't count as a framework. The receipt harness stays separate, which is correct because it runs three workers and a restart.

**Assertion strength.** All three PROBES suites keep their assertions. The summary suite's one changed assertion is the service lane's absent-get change at `definition-summaries-workerd.test.ts:218-221`. It now expects `toEqual({ status: 200, body: { value: null, graphReads: 0 } })`, an exact match, while `start`/`schedule` on an absent slug still expect `not_found`, and the corrupt-graph case still returns its distinct revision error for `get`, `start` and `schedule` (lines 202-211). The code agrees: `Registry.get` returns `SavedLoopy | null` (`service/registry.ts:17`, `apps/cloud/src/artifacts.ts:113-117`) and the probe calls `registry.get` directly (`fixtures/summary-workerd.ts:142-143`). This is consistent with the triage decision to encode absence as null and translate it at the service boundary.

**Docs against code.**

- The layer list matches `ALLOWED_IMPORTS` in `architecture.test.ts:26-38`, including service importing only core and contract, and local composing service.
- The portable bundle check covers core, engine, contract and service (`architecture.test.ts:107`).
- Package exports are `.`, `./contract`, `./engine`, `./graph` and `./local`, which matches both the AGENTS and CONTRIBUTING entry lists. The test script names all three gated roots.
- `RECEIPTS_PATH`, Origin rejection, local-stage and loopback checks, the namespace header, the token's 32 to 256 length, the namespace regex, the absolute-root rule and the principal-token inequality all match `apps/cloud/src/receipts-route.ts:7-63`.
- Bindings and the `v2-receipts` migration match `wrangler.jsonc:12-21`. `HttpSandboxAuthority` exists.
- Filesystem authority makes no persistent epoch claim (`filesystem-authority.ts:44-46`).
- `Attempts.open` validates the root and takes the lock before it calls the factory, then opens a session and reconciles guards and attempts (`attempts.ts:64-80`).
- The playground refuses populated `receipts`/`exports` directories when selecting durable mode (`scripts/playground/receipt-selection.ts:6-9`).
- The `receipts/`, `results/` and `exports/` directories match `config.ts:50` and the journal and result-store paths.
- Deleting the hardcoded personal paths is correct.

## Findings

### D1. Maintainability regression: the same policy now lives in four documents

`AGENTS.md:75`, `CONTRIBUTING.md:9`, `apps/cloud/README.md:57`, `apps/sandbox/README.md:103` (test isolation), plus `AGENTS.md:77`, `CONTRIBUTING.md:22`, `apps/cloud/README.md:100`, `apps/sandbox/README.md:101` (retained-data exit conditions).

The quality-tests isolation paragraph and the test-gate root list appear four times, with slightly different wording in each. The retained-data exit conditions also appear four times. The next change to either policy has to find and edit all four copies, and the wording has already drifted ("bounded quality work" vs "bounded quality runs", "Leave global TMPDIR unchanged" vs "Do not set global TMPDIR"). Operator READMEs aren't where contributor test policy belongs.

Smallest fix: keep test isolation and the gate roots in AGENTS.md only. CONTRIBUTING already says "Read AGENTS.md for code ownership and conventions", so cut its copy down to one sentence. Delete `apps/cloud/README.md:57` entirely. In `apps/sandbox/README.md:103`, keep only "Run the boundary tests without Docker:". For retained data, keep the full exit condition in the README that owns each path: the filesystem decoder in the sandbox README and summary repair in the cloud README. AGENTS.md keeps one line per path pointing at those READMEs, and the CONTRIBUTING copy can go. The other copies would mention phase 2 approval for a fourth and fifth time. The cloud README already states it at line 5.

### D2. Doc correctness, minor: campaign vocabulary in durable docs

- `apps/cloud/README.md:57` ends with "Root integration owns the full check gate." "Root" is the orchestrator of this review pass. A future reader of an operator README has no such role. D1's fix deletes this line anyway.
- "Bounded quality work" (`AGENTS.md:75`, both READMEs) names this campaign, not a kind of test. 23 test files in `packages/loopy/_tests_` still use `os.tmpdir()`, and `readmodel-counts` and `readmodel-scopes` still use `.loopy/architecture-tests`. As written, a reader can't tell whether the rule covers ordinary tests. Smallest fix: name the mechanism, for example "Tests that need repository-local state allocate it with `fixtures/quality-test-root.ts`, which creates a unique `.loopy/quality-tests` child with its own `.loopy/loopies` marker." Keep the TMPDIR and child-environment sentences as verification-run guidance.
- `apps/sandbox/README.md:35` says programmatic callers "pass an explicit dependency factory". The parameter is optional, and omitting it selects `filesystemDependencies(config)` (`server.ts:168-176`). Fix: "DO-backed callers pass a dependency factory to `startSandbox(config, createDependencies)`; omitting it selects filesystem authority."

### T1. Maintainability, low: a fourth temp-root allocator was added without retiring an existing one

`fixtures/quality-test-root.ts` is new, but `fixtures/readmodel-directory.ts` remains (used at `readmodel-counts.test.ts:20` and `readmodel-scopes.test.ts:19`). It does the same job, synchronously, under `.loopy/architecture-tests` and without a marker. Opus T4 had already counted about eight copies of this helper. The upkeep report says why it stayed (native SQLite suites still use it), and those two suites are outside this lane's scope. Follow-up: switch both suites to `await qualityTestRoot("readmodel")` and delete `readmodel-directory.ts`. The marker is harmless there. Not blocking.

### T2. Preference: a redundant `runtime` alias repeats strings the helper already encodes

`definition-summaries-workerd.test.ts:11,22,92` and `readmodel-workerd.test.ts:9,19,74`. Both suites still declare `let runtime: Miniflare`, copy `harness.runtime` into it, and call `runtime.unsafeEvictDurableObject("summary-tests", "SummaryProbe", …)` / `("readmodel", "ReadmodelProbe", …)` by hand. That repeats the worker name and class that `harness.evict` already encodes, so renaming either option without updating the literal would make eviction target a nonexistent object. Fix: replace those calls with `await harness.evict("legacy")` / `harness.evict("counts")`, use `harness.runtime.getR2Bucket` at lines 128, 186 and 244, and delete the alias and the `import type { Miniflare }`.

### T3. Preference: the failure path can mask the original error

`workspace-read-queue.test.ts:200-205`. If `writeFile` throws in the catch (disk full, removed directory), that error replaces the assertion failure. Fix: wrap the write in its own `try { … } finally { console.error(…) }`, or use `.catch(() => undefined)`, so `throw cause` always runs. Also, `record("proof-passed")` at line 199 and the unconditional `console.log` of the state path at line 48 now describe a directory that is deleted on success. Either drop them or log the path only on failure.

### T4. Edge case, no regression: a hung startup leaks its directory

If `probeRuntime` hangs past the 60 s `beforeAll` timeout, `harness` stays undefined and `afterAll` cannot remove the directory. At HEAD, `directory` was assigned before the build, so `afterAll` could still `rm` it. The same goes for the read-queue test, where a Bun timeout skips both the catch and the `rm`, as it did at HEAD. Accept it, or have `probeRuntime` accept a caller-owned directory. No action recommended.

## Out of scope and limits

- I did not run the 21-test/2,799-assertion suites, the harmless-edit control or the serialization mutant. I read the upkeep report's description of them and confirmed that the control mutation targets a real line (`apps/cloud/src/workspace.ts` serial queue) and that the failure it reports maps to the assertion at queue test line 159. I did not re-execute either.
- The provider fixture is unchanged, so I reviewed it only as a caller.
- I didn't review the service, persistence, projection or query lanes beyond the absent-get consistency check above.
- Per root's earlier decisions I didn't reopen historical evidence, manual proof programs, playground profiles or legacy decoding retention. The docs state those reasons and exit conditions accurately. D1 is only about where that text lives.
