# Modal probe independent review, round 1

Verdict: request changes before proposing the executable live probe for approval. Three correctness gaps remain in cleanup and existing-app admission. Offline preparation can continue. No cloud action is approved by this review, and user-selected workspace/environment names are still pending.

Reviewed branch `cloud-integration` at `b02de1b97300573891b020c5539690bf94a4e7ae` on 2026-10-22. Classification: minor feature, a standalone bounded provider probe. This is a fresh review of the uncommitted probe, with no prior probe review findings. Phase 1 acceptance is unchanged. Full staging implementation and deployment readiness are outside this verdict.

## Blocking findings

### 1. P2: interrupted journal publication can permanently prevent name-based cleanup

Location: `scripts/cloud/modal-probe-journal.ts:59-64`, with the failure handled at `scripts/cloud/modal-probe-run.ts:250-273`.

`writeExclusive` opens the final record path before writing its JSON. A worker kill between `open("wx")` and the completed write leaves an empty or truncated final file. This matters after `gateway.create` has allocated a sandbox but while `recovery-created.json` is being written at `modal-probe-run.ts:105-106`. Cleanup parses the damaged created record before choosing the saved-ID or exact-name path. Parsing throws, so the catch reports `unknown-or-identity-error` without trying name lookup. Every later stop repeats the same failure. The durable create intent survives, but the implemented recovery path cannot use it.

Offline reproduction: created a synthetic journal with recovery intent, an empty `recovery-created.json`, and a fake gateway that could discover the correctly tagged live sandbox. `inventory(..., "stop")` returned `unknown-or-identity-error`, made zero name lookups and made zero termination calls. No real SDK or provider was involved. The existing lost-acknowledgement test covers an absent record, not an interrupted final record.

Smallest fix: publish complete records atomically while preserving exclusive admission. For example, write and sync a unique private temporary file, link it to the final path with no overwrite, then sync the directory. Do not replace exclusive admission with an overwriting rename. Preserve the rule that no remote action occurs until its intent has been durably published. If supporting journals already damaged this way, reconcile only through the original exact name and ownership tags, retaining the damaged evidence and uncertainty.

Missing assertion: interrupt publication after opening the record but before completing its contents. The visible final record must be either absent or complete, never partial. After a remote allocation, stop must recover the exact tagged identity and terminate it without another create. Retain the duplicate-execute assertion that the losing admission makes zero connections.

### 2. P2: the empty-app check misses active V2 sandboxes

Location: `scripts/cloud/modal-probe-gateway.ts:97-106`; admission trusts that result at `scripts/cloud/modal-probe-run.ts:69-74` and `94-97`.

The worker deliberately sets `MODAL_SANDBOX_V2=false`, then `app()` uses `client.sandboxes.list`. In pinned SDK 0.11.1 that selects the V1 listing RPC. The shipped SDK explicitly says V2-created sandboxes are not returned by this list path. Its `experimentalList` documents listing both V1 and V2. See `node_modules/modal/dist/index.js:77202-77207`, `77377-77395` and `77415-77443`.

Consequently, an explicitly named existing app with the approved ID, no Functions or Servers, and an active V2 sandbox is reported as empty. The probe then creates resources in a populated app despite the documented empty-app requirement. This is an admission bug; it does not imply the code terminates that unrelated sandbox.

Smallest fix: either remove existing-app reuse from this first probe, or check all active sandbox versions through the supported public listing method that includes both, scoped to the exact app ID. Keep creation and recovery on the explicitly selected V1 routes. Do not add `includeTerminated` to V1 name lookup.

Missing assertion: exercise the gateway with a fake SDK where the V1 list is empty and the same app has an active V2 sandbox. Admission must reject it before app/sandbox creation or process start. The current fixture's manually assigned `appPopulated` boolean at `cloud-modal-probe.test.ts:97,105` cannot detect selection of the wrong SDK listing method.

### 3. P2: fresh approval cannot enable cleanup after source changes as documented

Location: `scripts/cloud/modal-probe-supervisor.ts:53-56`, `scripts/cloud/modal-probe-worker.ts:40-48`, `scripts/cloud/modal-probe-plan.ts:175-176`; contrary recovery instruction at `.notes/cloud/modal-probe-implementation.md:41`.

Both supervisor and worker require current source to match the implementation hash in the original manifest for every action, including stop. A fresh stop approval for that original manifest does not overcome a changed implementation hash. Revising the manifest to bind the changed source also fails: the manifest hash is part of the sandbox's original `loopy-manifest` tag, so ownership validation rejects that sandbox under the revised manifest. Fresh approval tied to a revised manifest is therefore not the offered cleanup recovery path.

Offline reproduction: a synthetic fresh stop approval for the revised manifest passed `authorize`. The original sandbox tags then produced `unknown-or-identity-error` with zero termination calls. Keeping the original manifest instead hits the source-hash guard before credentials or connection. Restoring the exact approved source remains possible if those bytes are available, but the probe does not archive them. This is especially relevant because these scripts are currently uncommitted.

Smallest fix: retain the original resource manifest and ownership hash. Either archive and verify the approved worker source before execution so cleanup can invoke those exact bytes, or allow a fresh scoped inventory/stop approval to bind a separate cleanup implementation hash while retaining original resource identity. Do not silently waive source verification or modify remote ownership tags. At minimum, remove the unsupported revised-manifest recovery instruction; a workable retained-source or separately approved cleanup path is needed before live execution.

Missing assertion: create an original tagged resource, change the cleanup implementation, and supply fresh scoped approval for the chosen recovery mechanism. Inventory/stop must reach and terminate only the original identity without another create. Also assert that fresh cleanup approval alone cannot authorize execute. Expired approval with unchanged source can already be renewed against the original manifest; that is a separate, working case.

## What the current code establishes

- The default plan's import graph has only a type import from Modal. `connectModal` performs the runtime import only after the worker checks approval, source hash, sanitized environment and private empty config. No constructor is invoked on the offline plan path. The child does not inherit ambient Modal profiles, tokens or endpoint overrides.
- Execution admission and create intents use exclusive records. Intent is awaited before each remote create. Repeated execute fails before connection. A lost create response is not retried at application level; absence after an ambiguous create remains unknown.
- There are two named logical sandbox creates. Recovery must reach confirmed terminal status before lifetime creation. Payloads request 120-second and 15-second lifetimes, 0.5 CPU with matching limit, 512 MiB with matching limit, blocked network, and fixed synthetic commands. No volumes, workflow secrets or personal files are supplied.
- Retained IDs use `fromId`. V1 live-name lookup omits `includeTerminated`. Wrong identity/tags do not trigger termination. A known ID that cannot be read stays unknown rather than becoming proof of absence. An unconfirmed termination prevents the second create.
- Normal supervisor error/timeout handling kills and awaits the SDK child, then attempts a separate cleanup worker under the remaining wall budget. Lifetime verification runs after a 17-second interval without an SDK child and requires status 124. Loss of the supervisor, a stale lock, slow discovery and provider errors can still prevent confirmed cleanup. The code does not promise otherwise or report those per-role unknown outcomes as clean.
- Inventory uses provider reads only. Its local lock/config handling and a possible synthetic `worker-failed` record are local writes. Stop has no create path. An app-discovery failure aborts the operation; per-role discovery failures become unknown observations. These paths fail closed, although they can leave cleanup unresolved.
- Worker errors and SDK logger output are suppressed. Process output is capped at 2,048 bytes; supervisor output is capped at 8,192 bytes. Public error messages are fixed text and journal records contain synthetic codes and validated IDs, not provider error bodies or token values.

## Tests and evidence limits

Ran exactly the scoped suite, with `TMPDIR` set to a temporary directory inside this worktree:

```sh
TMPDIR="$task_review_tmp" bun test packages/loopy/_tests_/cloud-modal-probe.test.ts
```

Result: 15 passed, 0 failed, 101 assertions across one file. The temporary directory and test data were removed. Two additional inline `bun --no-env-file -` reproductions used private synthetic journals and fake gateways only. Their outputs were:

```json
{"scenario":"interrupted-created-record","state":"unknown-or-identity-error","lookups":0,"stops":0}
{"scenario":"fresh-approval-revised-source-manifest","approvalAccepted":true,"remoteTagChanges":true,"state":"unknown-or-identity-error","stops":0}
```

The meaningful existing cases cover duplicate admission, lost app/sandbox acknowledgements, wrong tags and app identity, missing discovery, bounded termination polling, timeout-code discrimination, output byte limits, watchdog killing, and actual local concurrent filesystem/effect fixtures. No existing tests were deleted or moved. The reviewed scripts and test are 1,648 added TypeScript lines and zero deleted lines; package metadata adds one dependency line and 93 lockfile lines. This reviewer changed no implementation or tests.

The fake gateway does not test actual SDK routing, scheduling, tags after termination or provider retries. The local watchdog test checks `watchChild`, not the complete execute/verify/finally-stop sequence. The offline-plan test uses an invalid config path, but SDK import itself swallows missing config errors, so that test alone would not catch an accidental future runtime import. Source inspection establishes the current import separation. Add a load/read tripwire if claiming that invariant from a test.

Did not run the full check, import the Modal SDK at runtime, read credentials/profiles or external state, call a provider/network/browser/Docker/service, delegate, commit, push or change main. The parent owns the full check. Read repository `AGENTS.md`, unslop, PR review, TypeScript patterns, worktree and document guidance. The requested report path overrides the document skill's generic storage workflow. Only this report is a retained reviewer write.

## Nonblocking disclosed limits

`modal@0.11.1` is exact in `package.json` and `bun.lock`. Static inspection confirms the constructor ignores advertised `maxRetries` and `timeoutMs`; unary retries default to three with an idempotency key. The probe correctly leaves `sdkRetriesDisabled` and `strictAllocationCapVerified` false. Two logical creates and a local watchdog do not prove a strict allocation or dollar cap.

The public workspace identity limitation, equally named environment under wrong credentials, unknown image-build cost/outcome and retained app/image resources are disclosed. They belong in fresh specific approval, not an invented compliance workflow. The saved-file experiment drops a known process handle and reconnects; it does not prove actual lost-RPC recovery or provider idempotency. No provider parity, full staging, cross-sandbox filesystem, post-termination artifact or production claim follows from passing it.

`.notes/cloud/approval-readiness.md` concerns the separate full staging rollout. Its unimplemented adapter, receipts and deployment bindings are not extra prerequisites for this narrower probe. The next review should cover the three fixes and their focused assertions, then the parent can prepare the exact named proposal for fresh user approval. This report neither requests nor supplies that approval.

## Source receipt

The seven implementation files were unchanged throughout this review. Recomputed combined `implementationHash`: `dde05d4e927c893028b70a3327ccd33feed479de574f4b4ce6523882f40106c8`. Individual SHA-256 values read at the end of review were:

```text
38d0d1a4db60ede78ef50cb0f1c07639ef74c92c66c257a9b2e468899433b96c  modal-probe-gateway.ts
86e5cd480d64abddf51b5ba71060b2fcaae727a67d75ab6ff58d15499d166f0b  modal-probe-journal.ts
52d0b1528b38cacf99dd26ca702e4d3e48f023e3e9dc596577d6af5a3a6327fa  modal-probe-plan.ts
e2811e40e504b47c6929f22a0c170aa3c4742af4edf4c9aab92b493d75b076f5  modal-probe-run.ts
1b23fb39135383e07d94787490715d2b573d4683056f13455bff546ca4b32218  modal-probe-supervisor.ts
bc429d3a83baec266b4f85cc96f67aa217f84e66552a86533ff6af6600800e75  modal-probe-worker.ts
ffd643ffcb541a1dddfd848f414481597cc46a080165081907b864001fe2b06c  modal-probe.ts
6b7898bdd0e88f93f401ff31dc6a0a761de07e22a0479251a752f57a23ea0552  cloud-modal-probe.test.ts
519dfa28893c21092af5cd71e6fcc8727e3dbe6d2443a074c0768da3dba01619  package.json
819d9434f5f2a11d9320cc584218064624f7169bd57b8126cffd7404b6256462  bun.lock
```
