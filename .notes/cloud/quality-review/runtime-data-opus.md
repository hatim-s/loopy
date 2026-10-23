# Runtime and read-model quality review (Opus)

Reviewer: independent code-quality review, read only. No checks, tests, services or code-importing commands were run. Findings come from static reading of source, callers and the diff.

## Source pins

- Worktree: `/Users/hatim.shakir/projects/loopy/cloud-integration`
- Branch: `cloud-integration`, HEAD `9d30ca923d168e299099758e0d95f3db3ba81cf0` (verified with `git rev-parse HEAD`)
- Primary range: `6ffecdfd60e16aaa335467684d918b3cd8b44813...9d30ca923d168e299099758e0d95f3db3ba81cf0`
- Commits, oldest first: `69de89c` Inject execution authorities and simplify host and read-model policy, `7f6976a` Record architecture workload evidence, `9d30ca9` Record main integration verification. All source in my scope changed in `69de89c`. The other two only add notes and evidence.
- Context baseline `dee31da...6ffecdf` was used only to tell older debt apart from new regressions.

## Inspected paths

Source, full current file plus scoped diff:

- `packages/loopy/src/host/activate.ts`, `activation-plan.ts` (new), `activation-work.ts`, `completion-event.ts` (new), `durable.ts`, `durable-work.ts`, `rate-limit.ts`
- `packages/loopy/src/core/queries.ts`, `core/store.ts`
- `packages/loopy/src/store/memory-nodes.ts`, `memory-queries.ts`, `memory-query-runs.ts` (new), `sqlite/nodes.ts`, `sqlite/query-nodes.ts`, `sqlite/query-runs.ts`, plus the class chains in `store/` and `store/sqlite/`
- `packages/loopy/src/service/service.ts` (before and after), `mutations.ts`, `queries.ts`, `run-views.ts`, `schedules.ts`, `input.ts`, `definition-catalog.ts`, `registry.ts`, `routes.ts:40-60`
- `packages/loopy/src/local/service.ts`, `local/registry.ts`, `local/daemon.ts`
- `packages/loopy/src/contract/definition-summary.ts`, `contract/index.ts`
- `apps/cloud/src/artifacts.ts`, `artifacts-definitions.ts`, `artifacts-projection.ts`, `artifacts-validation.ts`, `artifacts-storage.ts`, and the callers in `workspace.ts`, `scheduler-schedules.ts`
- `packages/loopy/src/engine/step.ts:100-175`, `engine/invoke.ts:70-160` for the suspend and retry policy

Tests, spot read only: `host-policy-model.test.ts`, `host-policy-model.ts`, `host-targeted-polls.test.ts:80-140`, `fixtures/summary-service.ts:1-40`, the list of new `_tests_` helpers, and `architecture.test.ts` layer rules.

Design intent: after forming my findings I read only grep hits for backfill and migration in `.notes/cloud/architecture/summaries-implementation.md` and `proposal.md`, to check whether the cloud summary backfill was deliberate. I did not read other reviewers' reports or acceptance verdicts.

## Size of the change in scope

| Area | Insertions | Deletions |
| --- | ---: | ---: |
| `host/` | 154 | 196 |
| `service/`, `local/service.ts`, `local/registry.ts` | 777 | 571 |
| `store/`, `core/` | 166 | 104 |
| `apps/cloud/src/artifacts*.ts`, `contract/definition-summary.ts` | 425 | 142 |
| Tests and fixtures touching these areas | about 3,700 | about 40 |

The host got smaller. The service split grew by about 160 lines net. Roughly 45 of those lines are pure forwarding, and the rest is the definition catalog and grouped counts. Cloud artifacts grew because of the summary projection, its backfill and the row byte budgets.

## Verdict

No correctness blocker in my scope. The host change is a real simplification and fixes a policy split between local and durable activation. The read-model change removes the worst cost in the old code: every SSE transaction and every `listLoopies` call used to read every graph from the registry. Where the change did make things harder to read, the causes are specific and fixable: a second forwarding facade on top of an older one, an implicit not-found contract repeated four times, a Store method left with no production caller, and a projection field list kept in sync by hand across two packages. None of these are dangerous today. Each one raises the cost of the next edit. Messier in the service layer, cleaner in the host, about even in the store, and more involved but justified in cloud artifacts.

## Findings, highest priority first

### 1. Two stacked forwarding facades make every service method a three-file edit

Category: valuable cleanup. Partly new, partly older debt.

Evidence:

- `packages/loopy/src/service/service.ts:165-205` is 25 arrow properties of the form `x = (...args: Parameters<Sub["x"]>) => this.sub.x(...args)`. Before the change, `service.ts` at `6ffecdf` held these methods directly, with no forwarding.
- `packages/loopy/src/local/service.ts:121-173` is about 40 more forwarders to the portable service. These existed before the range, so they are older debt.
- `packages/loopy/src/service/mutations.ts:5,10` imports `type LoopyService` from `service.ts`, and `service.ts:13,29` constructs `new ServiceMutations(options, this)`. That is a type-level import cycle between two files in the same layer.
- `packages/loopy/src/service/routes.ts:43-52` needs `AwaitableMethods<Pick<LoopyService, "graph" | ...>>` only because the local wrapper overrides four methods with synchronous versions.
- `local/service.ts:84-95` `graph()` now does the same thing as the portable `service.ts:74-78` `graph()` through the registry adapter at `local/service.ts:51-62`. The local override is a duplicate.

Consequence: adding one route method now means editing the sub-service, the portable forwarder and the local forwarder. Before the range it was two places. Forwarders built from `Parameters<>` also hide the real signature from editor navigation. Go-to-definition lands on the forwarder, not the method.

Smallest safe correction, in order:

1. Delete the local forwarding layer. Make `local/service.ts` build `ServiceOptions` (registry adapter, `SecretStore` closures, `generateTypes`) and either return a `PortableService` instance or `extends PortableService`. Delete the local `graph()` and the secret method copies, because the portable versions already go through `options.secrets` and `registry.get`. Then `RouteDependencies.service` becomes `LoopyService` and `AwaitableMethods` can be deleted.
2. Optional: break the `mutations.ts` cycle by passing `ServiceRunViews` and a `requireRun` function instead of `Pick<LoopyService, ...>`. Fold the three copies of `now()` (`service.ts:32`, `mutations.ts:13`, `run-views.ts:45`) and the inline clock reads in `schedules.ts:81,126` into one helper next to `ServiceOptions`.

Validation: typecheck every consumer (`local/daemon.ts`, `apps/cloud/src/workspace.ts`, the dashboard, and the 18 test files that import `LoopyService`). Run `service.test.ts`, `server.test.ts`, `dashboard-http.test.ts`, `cloud-service.test.ts`, `definition-summaries-service.test.ts` and the secrets tests. Confirm a missing slug through `GET /loopies/:slug/graph` still returns 404 with the same message.

### 2. Not-found for definitions is an unwritten contract, and its message is copied four times

Category: valuable cleanup. New in this range.

Evidence:

- `service/registry.ts:17` declares `get(slug): Promise<SavedLoopy>` with no stated failure contract. The service now calls it bare at `service.ts:38`, `service.ts:75`, `schedules.ts:17` and `queries.ts:90`. Before the range, `startRun` threw `ServiceError("not_found")` itself, and `graph` and `loopySource` wrapped any error as `not_found`.
- So each registry implementation now has to throw `ServiceError("not_found")` itself: `apps/cloud/src/artifacts.ts:116-120` and `local/service.ts:54-59`. A storage adapter now imports HTTP error vocabulary.
- The message ``No saved loopy '${slug}'. Use loopy save <file.ts> first.`` appears at `local/registry.ts:37`, `local/service.ts:57`, `local/service.ts:90` and `apps/cloud/src/artifacts.ts:119`.
- Local makes a round trip: `RegistryMissingError` becomes `null` in `currentDefinition` (`local/service.ts:14-24`), and then becomes `ServiceError` again in two places.
- `summary(slug)` on the same interface already returns `DefinitionSummary | null` (`registry.ts:16`), so the interface uses two absence styles side by side.

Consequence: a third registry implementation, or a refactor of either existing one, that throws a plain `Error` turns a 404 into a 500 on start, graph, schedule and source routes, and the compiler cannot catch it. Copy edits drift across four copies.

Behaviour change to record: `graph` and `loopySource` used to map any error, including a missing or corrupt R2 graph, to `not_found`. Now a corrupt stored graph surfaces as a 500 with the "Save the loopy again" message. I think that is more correct, but it was not listed as a behaviour change.

Smallest safe correction: change `get(slug)` to return `Promise<SavedLoopy | null>`, matching `summary`. Add one `requireDefinition(registry, slug)` in `service/` that throws `ServiceError("not_found", message)` from a single message constant. Local returns `currentDefinition(...)` directly. Cloud returns `null` when there is no pointer. Remove `ServiceError` from `apps/cloud/src/artifacts.ts`. The cloud scheduler (`scheduler-schedules.ts:50`) also calls `get`, so it needs an explicit null branch. Check what it should do there.

Validation: typecheck the cloud app and package. Run `registry.test.ts`, `registry-isolation.test.ts`, `service.test.ts`, `cloud-service.test.ts`, the definition summary tests and the cloud scheduler tests. Assert 404 for a missing slug on start, graph, schedule put, enable, delete and loopy source, in both local and cloud.

### 3. `runCounts` lost its last production caller but stays in the Store contract

Category: valuable cleanup, dead code. New in this range.

Evidence: `git grep "\.runCounts("` at `6ffecdf` shows one production caller, `service/service.ts:517`. At HEAD no file under `packages/loopy/src` or `apps` calls it. The method is still declared at `core/queries.ts:153` and implemented at `store/memory-query-runs.ts:72-82` and `store/sqlite/query-runs.ts:110`. The only remaining callers are tests: `dashboard-queries.test.ts:86`, `fixtures/readmodel-copied-data.ts:181`, `fixtures/readmodel-history.ts:24,28`, `fixtures/cloud-pagination-probe.ts:86`. `fixtures/summary-service.ts:20` overrides it to throw.

Consequence: every Store implementation, including any future cloud store, has to carry a filtered count query that nothing uses. It survives only as an oracle for tests. That is the "keep the old path for tests" pattern the repo rules reject.

Smallest safe correction: remove `runCounts` from `DashboardReader` and both stores. Rewrite the equivalence oracles to compute expected counts in the test, by folding `queryRuns` pages or by a raw `SELECT` in the SQLite fixture. Delete the throwing override in `summary-service.ts`. The "grouped counts are used" assertion can stay on `groupedReads`.

Validation: typecheck. Run `readmodel-counts.test.ts`, the copied-data and history read-model tests, `dashboard-queries.test.ts` and the cloud pagination probe. Mutation check: break `runCountsByDefinition` (for example, drop `status` from the GROUP BY) and confirm the rewritten oracle fails.

### 4. The summary projection's field list and input rule are kept in sync by hand across two packages

Category: valuable cleanup, with one concrete failure mechanism. New in this range.

Evidence:

- The field list appears at `contract/definition-summary.ts:5-16` (schema pick), `:20-31` (the `definitionSummary` body), `apps/cloud/src/artifacts-projection.ts:8-14` (projection pick), `:21-23` (`projectionJson` destructuring) and `artifacts-definitions.ts:91-96` (pointer columns merged back).
- The rule `inputValidation?.root === "json" ? "schema" : input` is written twice: `contract/definition-summary.ts:28` and `artifacts-projection.ts:62`. The second copy runs in the pre-R2 size check over `{ ...body.graph.meta, input }`, while publication derives the stored value through `definitionSummary(artifactEntry(row, graph))` (`artifacts-definitions.ts:168`). The two derivations are only equal by coincidence.

Failure mechanism: add a field to `definitionProjectionSchema` but forget the destructuring in `projectionJson` (`artifacts-projection.ts:21-23`). TypeScript accepts it, because the destructuring silently ignores the extra key. Every new publication then stores JSON without the field. `ArtifactDefinitions.summary` (`artifacts-definitions.ts:96`) parses it with the strict schema and throws. That call sits outside the `try` in `resolveSummary` (`artifacts.ts:74`), so `listSummaries` throws for the whole workspace. Fixing `projectionJson` afterwards does not heal those rows: their generation matches and `projection_json` is not null, so `repair` skips them, and each one needs a manual re-save.

Smallest safe correction:

- In `projectionJson`, build the object with `satisfies Record<keyof DefinitionProjection, unknown>`. The compiler then rejects a missing key, and key order stays fixed for the equality check at `artifacts-definitions.ts:170`.
- Export one `definitionInput(graph)` from `contract/definition-summary.ts`. Use it in `definitionSummary` and `checkDefinitionRows`.
- Optional: `artifactEntry` lives in `artifacts-validation.ts` but builds a `SavedLoopy` from a row and a graph. It is a projection, not validation, and it creates a type cycle with `artifacts-definitions.ts`. Moving it next to `Publication` would remove the cycle.

Validation: typecheck the cloud app. Run `definition-summary-size.test.ts`, `definition-summaries-workerd.test.ts` and `cloud-artifacts.test.ts`. Mutation check: delete one key from the `projectionJson` literal and confirm `tsc` fails.

### 5. `acquireDispatch` takes a `lookup` callback that the durable caller fakes

Category: valuable cleanup, low cost. New shape, older concern.

Evidence: `host/rate-limit.ts:4-9,26-28` takes `lookup` only to skip limits when a receipt already exists. `host/durable-work.ts:57-63` passes `lookup: async () => receipt` after it has already established `receipt.kind === "none"`. `host/activation-work.ts:125-139` binds `executor.lookup`, and `execute()` at `activation-work.ts:17` then looks up the same receipt again. That is two receipt reads per rate-limited local dispatch.

Consequence: this is far better than the 80-line loop it replaced. The remaining callback is still a small indirection that makes readers ask why a closure returns a constant.

Smallest safe correction: have `acquireDispatch` take no lookup and assume the caller already saw `none`. In local, move the admission into `execute()` behind the `receipt.kind === "none"` branch. `execute` then returns either an `ExecutionResult` or the `rate_limited` event, as a two-member union. Durable calls it directly.

Validation: run `host-admission-race.test.ts`, `host-denial-fence.test.ts`, `host-policy-model.test.ts` and the rate-limit tests. Confirm that a started or finished receipt still bypasses admission.

### 6. The suspend-while-retrying policy is split between reducer and host

Category: design cleanup across layers, not urgent. The filter is older (durable had it at `6ffecdf`). This range spreads it to local.

Evidence: `engine/step.ts:115-141` emits `suspend_run`, folding pending `schedule_retry` deadlines into `wakeAt`. `host/activation-plan.ts:15-27` then drops that same `suspend_run` whenever a node is `retrying` or `rate_limited`. The reducer produces an effect whose meaning the host has to override.

Consequence: the reducer's output means "suspend" in tests but not in either host. Anyone changing suspension in `step.ts` also has to know about the filter in `activation-plan.ts`. Sharing the filter across both drivers is still an improvement, since local used to release the lease in this case. AGENTS.md says retries retain the lease.

Smallest safe correction: in `suspend()` (`step.ts:115`), return early when any node is `retrying` or `rate_limited`, next to the existing `executing` check. Delete the `retaining` branch from `planActivation`. This touches the engine, so it needs the PR 4b/4c owner's agreement.

Validation: engine transition tests for a waiting sibling plus a retrying sibling, `host-slot-retention.test.ts`, `wait-host.test.ts`, and the host model test.

### 7. The cloud summary backfill is a compatibility read path with no exit condition in source

Category: documentation or preference. New and deliberate.

Evidence: `apps/cloud/src/artifacts.ts:63-111` (eight-attempt loop, byte budget, generation re-read) and `artifacts-definitions.ts:118-130` (`repair`) exist so that pointers published before `artifact_definition_summaries` existed get a projection on first read. `proposal.md` says this is intended for accepted cloud data. Nothing in the source says when the path can go.

Consequence: the repo rules accept compatibility only for persisted user data, and only with a written exit condition. Without one, this path will outlive the data it serves.

Smallest safe correction: add one sentence above `resolveSummary` naming the exit condition, for example "Remove once every workspace's pointers have projections". Optionally add a test that fails when no pointer lacks a projection. Do not remove the generation fence or the race handling.

Validation: none beyond review.

### 8. Tests pin call counts and the helper layout is inconsistent

Category: subjective, test maintainability.

- About 3,700 lines of tests and fixtures support roughly 500 net source lines in this scope. Most cover durable boundaries and races, which AGENTS.md asks for. Several assert implementation call counts rather than outcomes: `fixtures/summary-service.ts:11-23` throws if `runCounts` is called, and `host-targeted-polls.test.ts:80-99` counts `getNodeRuns` and `getNodeRun`. These pin performance properties, which is defensible for read-model scale. They will still break on harmless refactors. Keep them, and add a comment on each saying which scale property it protects.
- `host-policy-model.test.ts:5-38` replays every trace from scratch at each BFS node to depth eight, with a 60-second timeout and a `console.log`. Watch its runtime in `bun run check`.
- New helpers are split between the `_tests_/` root (`host-policy-fixture.ts`, `host-policy-model.ts`, `host-policy-replay.ts`) and `_tests_/fixtures/` (everything else). Pick one.

## Older debt this range touched but did not create

- The memory store is a nine-level inheritance chain used to split files (`MemoryEvents` up to `MemoryStore`). This range adds one link, `MemoryQueryRuns`, which mirrors `SqliteQueryRuns`. It is consistent with the existing pattern. I would not restructure it here.
- `listLoopies` (`service/run-views.ts:122-165`) still runs one `queryRuns` and one `pendingHooks` per definition, one after another. Counts went from N queries to one, but recent runs are still N+1. It was already N+1 at `6ffecdf`.
- `runCountsByDefinition` (`store/sqlite/query-runs.ts:133-139`) groups the whole `runs` table on every `listLoopies` call, and no index covers `(workspace, slug, status)`. The old per-slug counts also touched every row through `runs_slug_created_id`, so the cost is about the same. Measure before adding an index, as the proposal says.
- AGENTS.md is out of date: "local/service.ts owns mutations and wire views", and the `service/` directory is not in the layout list. That was already stale before this range, and the split makes it more so. The repo's own refactor bar asks for the new layout to be written down. Update the Ownership section for `service/` and `host/activation-plan.ts`.
- `local/service.ts` forwarders (see finding 1).

## What improved

- **Host policy is shared, and the old local bug is gone.** `planActivation` (`host/activation-plan.ts`) is one 42-line owner for "which effects persist, which become work, what the outcome is". At `6ffecdf`, local activation persisted `suspend_run` even with a retrying sibling, which released the lease. Durable did not. Both now behave the same.
- **Rate limiting is far simpler.** `acquireDispatch` went from an 80-line loop that re-ran `step` and spliced effects to a 48-line function that admits one dispatch and returns an optional `rate_limited` event. Durable no longer builds a fake `Executor` whose `execute` throws. Admission now runs after the dispatch is persisted, which matches "persist an execution before dispatch". One visible side effect: a denied local dispatch now writes `running` and then `rate_limited`, two node events instead of one.
- **Duplicated completion mapping is gone.** `completionEvent` replaced two copies.
- **Durable reconciliation reads less.** `durable-work.ts:33` reads one node through the new `getNodeRun` instead of rebuilding the full state, and `:82` skips a redundant `started` write.
- **Read-model cost dropped sharply.** The old `viewResolver` called `registry.list()`, which in cloud reads every graph from R2, on every SSE transaction and every list. Now `DefinitionCatalog` resolves cached summaries per slug, and warm cloud paths read no graphs.
- **Scope items no longer hit the bound-parameter limit.** `sqlite/query-nodes.ts:122` switched from variadic `IN (?, ?, ...)` to `json_each(?)`, which avoids workerd's bound-parameter ceiling. Small and correct.
- **Cloud parse errors are actionable.** `parseGraph` (`artifacts.ts:126-140`) now wraps parse failures with a message that says what to do.
- **Ownership is clearer.** `ArtifactDefinitions` pulls pointer SQL, quota and publication out of `R2ArtifactRegistry`, so the registry file reads as storage plus summary resolution.

## Scope gaps

- I ran nothing. Test pass/fail, timing of the BFS model test, and typecheck status are not verified by me.
- I did not review `executor/`, `apps/sandbox/`, `apps/cloud/src/receipts*.ts`, the contract's sandbox-journal files or `scripts/playground/`. They are outside my assigned scope.
- I read test files only in spots. I did not mutation-check any new test.
- I did not check `routes.ts` beyond the dependency type, or the dashboard consumers of `LoopyView`.
- I did not verify whether `registry.project` always equals `canonicalPath(workspace)`. The grouped counts rely on that equality, as the old filter did.
