# Service and data review, round 2

## Verdict

Approve within the assigned static scope. No actionable correctness or code-quality finding. No requested source fix.

This is a minor refactor with explicitly authorized absence-contract and test-oracle cleanup. The changes remove one forwarding layer, express absence in the registry type, delete unused production queries and protect projection serialization. They do not introduce an unnecessary framework.

## Review pins and method

- Checkout: `/Users/hatim.shakir/projects/loopy/cloud-integration`.
- Branch: `cloud-integration`.
- Base and verified HEAD: `9d30ca923d168e299099758e0d95f3db3ba81cf0`.
- Compared current uncommitted files against HEAD, including untracked `service/definition.ts`. This is not a review of the earlier committed architecture range.
- Read AGENTS.md, unslop, pr-review, TypeScript craft and its TypeScript, architecture and test references, plus worktree guidance. Inspected source and callers before reading `runtime-data-sol.md`, `runtime-data-opus.md`, `TRIAGE.md` and the three assigned fix reports.
- Scoped production delta: 63 added, 172 deleted across 15 files, including the new helper. The 13 pinned changed test/fixture files total 200 added, 102 deleted. That test total includes sibling harness edits in `definition-summaries-workerd.test.ts`; those edits are outside this verdict.

## Assessment

### Service ownership and callers

`packages/loopy/src/local/service.ts:25` is now a thin subclass supplying native dependencies. It removes the local forwarders and duplicated graph/secret implementations. The portable facade still routes to its existing concern owners, so adding a portable method no longer requires another local forwarding property. Keeping that existing concern split is reasonable.

The resulting call path is:

```mermaid
flowchart LR
  HTTP[HTTP route] --> Portable[Portable service method]
  Portable --> Require[requireDefinition]
  Require --> Adapter[Native or R2 registry]
  Adapter --> Require
  Require --> Portable
```

Local direct `graph`, `listSecrets`, `putSecret` and `deleteSecret` calls intentionally return promises and reject on failure. The discovered synchronous graph callers were updated. Routes already await results through async endpoint handlers. The constructor inputs and returned graph/secret payloads remain the same. Native secret mutations still translate plain storage/validation failures to `bad_request` through the portable implementation. No detached production method caller was found that would depend on the removed bound forwarding properties.

`service/definition.ts:4` earns its small abstraction: four service lookup paths need the same null-to-`not_found` translation. `service/registry.ts:17` now states that absence explicitly. Local conversion catches only `RegistryMissingError`; R2 `get` returns null only for an absent pointer at `apps/cloud/src/artifacts.ts:113`. JSON/schema failures, missing published graphs and revision verification failures continue to propagate. `service/routes.ts` maps the coded absence to 404, while the native and cloud outer handlers map uncoded storage failures to 500. The changed native HTTP test covers six absence and six corruption requests. Workerd probe status 400 is its test wrapper's error convention, not the public service status.

This preserves the existing registry treatment of unsupported legacy entry versions. It does not redesign native registry decoding. The preexisting broad `runGraph` catch also remains unchanged; the current-definition cleanup does not claim to fix pinned-graph error classification.

### Scheduling and revision identity

`apps/cloud/src/scheduler-schedules.ts:48` handles null inside the existing per-row try/catch. It creates no run, retains the schedule and records the existing retry deadline. Other due schedules can continue. Successful recovery uses the restored definition's graph and revision in the same fire request, while store version fencing and subsequent run revision pinning remain unchanged. The changed scheduler test checks the absent case, healthy progress, retry timing, restoration and a later save that leaves the run's revision intact.

Portable schedule mutations still resolve the registry's workspace before accessing schedule records. The local subclass does not introduce a second schedule implementation or alter canonicalization.

### Count queries and test independence

The removed `runCounts` method has no remaining TypeScript reference under packages, apps or scripts. Grouped counting, overview aggregation, filtering and persistence code are unchanged.

`fixtures/readmodel-history.ts:18` folds independent `queryRuns` pages of two records, including the equal-timestamp ID tie break. `fixtures/readmodel-assertions.ts` compares those per-identity and global-slug totals to grouped rows and retains explicit transition totals, positive counts, unique group identities, separator-containing identities and rollback cursor checks. Dropping status or workspace from grouping cannot make both sides agree merely because they call the same aggregate implementation.

`fixtures/readmodel-copied-data.ts:114` reads individual authoritative rows. Its revised checks compare all-run, workspace/slug, global-slug and workspace totals without repeating the production GROUP BY. The known 205-run pagination fixture is also independent of grouped counts. No test case was deleted or moved. Removing the dead throwing override in `summary-service.ts` follows deletion of its production method; the one-grouped-read scale assertion remains.

### Projection completeness and byte budgets

`apps/cloud/src/artifacts-projection.ts:24` preserves the original `scope, description, input, schedule, mode` property order and JSON.stringify behavior. `satisfies DefinitionProjection` now rejects an omitted required projection field and checks its value type. All five current fields are required, including the nullable ones.

`contract/definition-summary.ts:21` shares the JSON-root input rule with preflight. The summary caller deliberately retains `saved.input` for non-JSON input, preserving the previous behavior rather than substituting graph metadata. Cloud publication obtains that saved input from the graph, so preflight and persisted projection still agree.

UTF8 accounting, pointer allowances, pre-upload checks and transactional projection checks are unchanged. Publication ownership, generation fences, identical-save repair and retained-data backfill remain in their existing owners. The added JSON-root test checks successful publication and exact persisted bytes. Existing escaped/multibyte, maximum-size, over-budget and legacy-read cases remain present.

## Verification and limits

Only static commands were run: `pwd`, git status/branch/HEAD/diff/numstat, scoped `git diff --check HEAD`, `rg`, `cat`, `sed`, `nl`, and a Python standard-library script to hash files and sum diff sizes. Branch and HEAD matched. Scoped production whitespace checking exited 0 without output. `rg -n '\brunCounts\b' packages apps scripts --glob '*.ts'` exited 1 without matches.

The fix reports describe 75 service tests, 19 query tests, 8 size tests and negative controls. Those are author-reported results from their lane snapshots, not independently rerun evidence from this review. The projection report's two interim absent-get assertion failures have corresponding corrections in the current test diff and a later reported service-lane run. Root still owns final integration and full checks.

No tests, typechecks, code-importing probes, services, ports, APIs, Docker, cloud actions, retained/private data access, children, commits or source edits were performed. Harness/tooling and receipt changes are outside this review. Deferred engine policy, child descriptor validation, retained-data removal and test-ratio proposals were not reopened. The only write is this report.

## SHA-256 pins

Changed production files reviewed:

```text
5c4aed5cc471d79d12402ee3c5ed20c1556a436c29413d6fbf2ede7c2012734e apps/cloud/src/artifacts-projection.ts
6d5f5ad069f24d49588ce2d4f740aa790530f1e63be55adfc4e3537039823d41 apps/cloud/src/artifacts.ts
0839f1ce82baa1eb9c0a4a125a1e82ab18546830546fbf3a0eae9748d3f201c3 apps/cloud/src/scheduler-schedules.ts
50c9c55321ddf22ea1002d23ca590b94edc7bec664ca3aa18fe291156e03470a packages/loopy/src/contract/definition-summary.ts
440f1ade58b5276135785997287649ae1721cbbf2591fb03e4f56fa0dcf011a1 packages/loopy/src/contract/index.ts
c1c165637619d8e3c2ce7650e549c64ad42b81af301568bea64f2ee4eba53102 packages/loopy/src/core/queries.ts
e47a83328e8fde2c047b00bfad3500d6bd8cdf233983df62ff5f9dac61cd8d0a packages/loopy/src/local/service.ts
0866500fb1666e79cab23bcb88045f7ccd02a8ffb3b34398dc0cc9c66c77e2df packages/loopy/src/service/definition.ts
3ee56f78c0211b7330bfe4c76a33e9d76c90b3cced369f6eb7414ccf4530f72f packages/loopy/src/service/queries.ts
c8f6b3a5944d8a3bf6c703d3cd88c9b6b2891bf68032e70b424ffa95c40c670a packages/loopy/src/service/registry.ts
c438d202be1f04a32c39b74dea8b709fdaf4d31cda1346276df45cf33fbd61e9 packages/loopy/src/service/routes.ts
ac8ba5d631b089f4d3aaa47c72dbe9d4704216152d5c832d23d2c8c1533454a1 packages/loopy/src/service/schedules.ts
727652ab4757305ae2f73cb067079826fb06d6cf2c83d9b56e44e4ea79dacb31 packages/loopy/src/service/service.ts
7045924392a8f96b8bf88e4fe9ec3420ce22e1326d4e9f9215d2102d1bb139ab packages/loopy/src/store/memory-query-runs.ts
36a04eb9baf99a27269514550953208d1ad25ca2eaa7d92351818135f6585ef2 packages/loopy/src/store/sqlite/query-runs.ts
```

Changed test and fixture files inspected:

```text
1f3cc7d7cb2f796767d1674619267c814e2b102fd070b107a3e788e56f2819eb packages/loopy/_tests_/cloud-artifacts.test.ts
64f91f65bbf14ec3b1fae5ed5fa562b2dec4649f71d14701f22a647ef95bc656 packages/loopy/_tests_/cloud-scheduler.test.ts
5cdc5043942ed828ae9b24541d7d651bc4684f6de045e925057e316ca79e5bbf packages/loopy/_tests_/cloud-service.test.ts
547042dfb9d5d78a5ed4f2aec957c4442df617333039680985f2ad72b8d91187 packages/loopy/_tests_/dashboard-queries.test.ts
0f1466edf4c78dadd450e256486939c2f2e4b74334a28f8c9272957a89cabaa6 packages/loopy/_tests_/definition-summaries-service.test.ts
a2f727ebb96d8eb3b02f4337cbbc5db9739848e96df5378aa2f7f57e0b8e32d2 packages/loopy/_tests_/definition-summaries-workerd.test.ts
7819ed37d02f7e87393ce659abc0b81a50ba24e78c57b08a108f9242ee5a8eb4 packages/loopy/_tests_/definition-summary-size.test.ts
9dadf9e220ba27aec34bab6174ab11a3927b0eb364f240cf9cb1c32790393353 packages/loopy/_tests_/server.test.ts
10f16bdefa13e79613d6d9835e943eef84917a9da4a767686c4e2199f37343b2 packages/loopy/_tests_/service.test.ts
29b61f623fba90a0aeb65cfc1ea0fe1fdda0ebab9f6e6d2def752e2c142bdb9f packages/loopy/_tests_/fixtures/cloud-pagination-probe.ts
0c5c2150e9ad6d1a1e815568523bddea0ee187f34e1cb06a63571feea6bdc69c packages/loopy/_tests_/fixtures/readmodel-copied-data.ts
a68c74c7c52f48fbbb20b701d97bbb0b51088cf1fb363b5a7819099014e2a417 packages/loopy/_tests_/fixtures/readmodel-history.ts
9e10d1e88d04ae863168b85808b4c2c603f8bc3c2ed13b75a60c39a7402c22a4 packages/loopy/_tests_/fixtures/summary-service.ts
```

Unchanged supporting owners and test oracles inspected:

```text
7e411dda351b696a77f85a25bdd5a20fdab12bcd0f5f1be40270068b3dfba86c packages/loopy/src/local/registry.ts
14f84afe56c3652d444b909e9a6458142763fd8599157d9f8a1aa2d0ade6a9e5 packages/loopy/src/local/secrets.ts
fc31b58e989210e3c617207d299bc85457c7c40b470d3d19527df21e8fc1501c packages/loopy/src/local/server/start-server.ts
422cb84d79849b685d06fb74b98c8df79eb0ae034d372412b51c29b1d39f9ace apps/cloud/src/workspace.ts
52845c7bd1427297858c169a7a8134974eb55485014d00314b2c8f057cbfdf9c apps/cloud/src/artifacts-definitions.ts
aa1e730f5ba93bcec808b44b16c6871765e66cf1413bbe5b5dadf694c9c22cd0 apps/cloud/src/artifacts-validation.ts
913d98ceff037f832d509ed07f58c5c96d1017963908b5c03615d9df6a3c0c99 packages/loopy/src/service/run-views.ts
201c19546efe28d004ebe6a458824054659ad11413007ef5d73ee1c3ed49639c packages/loopy/src/service/definition-catalog.ts
fe78216e9cef0a3c1503ca135fc0e10f1924d38d98391d45d5af388592837afa packages/loopy/_tests_/fixtures/readmodel-assertions.ts
f3889b21bdaeccfb926f2d198d9cc2d942920f0254537adc650a23ecfee53941 packages/loopy/_tests_/readmodel-counts.test.ts
d61df712cd76f06e34f8a214c09078d480752c056410da208f558288960bdd7a packages/loopy/_tests_/fixtures/summary-size-body.ts
```
