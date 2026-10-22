# Modal probe independent review, round 2

Verdict: no blockers found in the frozen local probe. The three round 1 findings are resolved by the implementation, with focused assertions that exercise their failure mechanisms. The parent can prepare the exact named proposal for Hatim's approval after its full check. This review grants no approval, credential access or provider execution.

Reviewed on 2026-10-22 in `/Users/hatim.shakir/projects/loopy/cloud-integration`, branch `cloud-integration`, HEAD `b02de1b97300573891b020c5539690bf94a4e7ae`. Classification: minor feature, one fixed two-sandbox provider probe. Phase 1 acceptance is unchanged. Full staging implementation, the parent's transport fixture changes and Docker checks are outside this review.

## Round 1 findings

### 1. Interrupted journal publication no longer exposes partial final records

`scripts/cloud/modal-probe-journal.ts:60-84` writes JSON into a unique owner-only temporary file, syncs and closes it, then publishes it with a hard link. The final path is never opened for writing. A kill before linking can leave a temporary file but no partial final record. After linking, the final record already contains the complete synced JSON. The directory sync completes before `put` returns.

The link operation refuses an existing destination. Exclusive admission therefore survives this change: `scripts/cloud/modal-probe-run.ts:151-155` awaits `execution-started` publication before connecting, and `104-106` awaits each intent before creation. A losing execute cannot overwrite the winner's admission or connect through that path.

The new test at `packages/loopy/_tests_/cloud-modal-probe.test.ts:510-557` runs an actual local child with a zero-byte file-size limit. Its failed publication leaves the final created record absent. Cleanup then uses the original intent, exact live name and ownership tags, records the recovered ID and confirms termination without another create. It also checks that a later publication cannot replace an existing record. The original duplicate-execute assertion at `269-279` still checks that the second call adds no connection. Source tracing establishes the publication ordering beyond that single interrupted-write point.

### 2. Empty-app admission now checks both sandbox versions

`scripts/cloud/modal-probe-gateway.ts:127-136` calls public `experimentalList` with the exact resolved app ID. Static inspection of pinned SDK 0.11.1 at `node_modules/modal/dist/index.js:77415-77460` confirms that this method lists running V1 and V2 sandboxes through `sandboxListV2`, with `includeFinished: false`. The SDK scopes by app ID when one is provided. App resolution still supplies the selected environment.

`scripts/cloud/modal-probe-run.ts:69-74` rejects a populated existing app before saving admission, and `94-106` rechecks the recorded app before either sandbox create. The new real-gateway test at `packages/loopy/_tests_/cloud-modal-probe.test.ts:560-645` gives the fake SDK an empty V1 listing and a populated all-version listing. Execution rejects before image creation, app creation, sandbox intent or process start. This catches the previous wrong-method selection rather than only testing a precomputed populated flag.

Creation remains V1 through the sanitized worker's `MODAL_SANDBOX_V2=false`. Name recovery at `scripts/cloud/modal-probe-gateway.ts:173-176` still omits `includeTerminated`. Static SDK inspection at `node_modules/modal/dist/index.js:77270-77301` confirms why that matters: either the V2 profile flag or `includeTerminated` selects experimental name lookup. The admission fix does not change the recovery route.

### 3. Changed cleanup code can retain the original resource identity

`scripts/cloud/modal-probe-plan.ts:149-189` permits a separately approved cleanup implementation hash only for inventory/stop authority. It still checks the original manifest hash, target, app name, action and expiry. Any approval combining `cleanupImplementationHash` with execute authority is rejected. Cleanup-only approval cannot authorize verify because verify requires execute authority.

Both live entry points call this same guard before reading credentials or importing the SDK: `scripts/cloud/modal-probe-supervisor.ts:53-57` and `scripts/cloud/modal-probe-worker.ts:40-47`. Neither contains an earlier unconditional comparison against the old implementation hash that would defeat the new cleanup path.

The original manifest remains the input to `tags` at `scripts/cloud/modal-probe-plan.ts:192-193` and the ownership checks at `scripts/cloud/modal-probe-run.ts:46-51`, `129-132` and `250-267`. Changing the approved cleanup implementation therefore does not change the remote identity being accepted. Wrong tags still prevent termination.

The new test at `packages/loopy/_tests_/cloud-modal-probe.test.ts:648-709` authorizes changed cleanup code, inventories and stops the originally tagged resources, preserves the original manifest hash and adds no creates. It denies execute and verify with either source hash, mixed execute/cleanup approval, a wrong cleanup hash and changed source without the override. The implementation note now describes retaining the original resource manifest rather than revising it.

## Adjacent boundary checks

- The offline entry point imports no Modal runtime. The gateway's top-level Modal import is type-only; the runtime import remains inside `connectModal` at `scripts/cloud/modal-probe-gateway.ts:244-246`. I inspected this import graph without invoking that function.
- The supervisor launches the worker with an explicit environment, `--no-env-file`, a private empty config, the fixed endpoint and V1 selection. The worker checks those values and the empty config before authorization, credentials and SDK import. Ambient profile and token variables are not passed by the supervisor. Invalid approval or source hash fails before credentials.
- Durable execution admission precedes connection. Create intents precede remote creation. Ambiguous creation retains intent and is not reissued. Recovery termination must be confirmed before lifetime creation. No inventory or stop path calls app or sandbox creation.
- Cleanup checks saved app identity when available, retained sandbox ID and original tags. Name discovery is limited to the planned app and role name. Unknown discovery and identity failures remain unknown, and cleanup continues accounting for the other role. An absent live name after an ambiguous create is not reported as confirmed absence.
- Lifetime verification still requires the saved identity, the absent-caller interval and provider exit status 124. It does not treat a generic termination as the requested timeout proof. The supervisor still kills and awaits the SDK child before starting its cleanup worker.

No new blocker was found at these boundaries. The review does not establish live SDK/server behavior.

## Verification and limits

Independently ran `bun --no-env-file test packages/loopy/_tests_/cloud-modal-probe.test.ts` with `TMPDIR` pointing to a newly created temporary directory and a reduced runner environment. Result: **18 passed, 0 failed, 145 assertions**. A local Bun wrapper created and removed that temporary directory using `node:fs/promises`. Test children used synthetic fixtures only. No test imported the Modal runtime or contacted a provider. An initial shell wrapper was rejected before execution because its cleanup used `rm -rf`; the successful wrapper managed only its own freshly created temporary directory directly.

Also ran read-only `git status --short`, `git branch --show-current`, `git rev-parse HEAD`, `git diff --numstat -- package.json bun.lock`, `wc -l`, SHA-256 checks and a `bun --no-env-file -` source-hash calculation using the pure plan module. Branch and HEAD matched the brief. The combined implementation and test hashes matched the supplied receipts. The reviewed addition contains 1,920 TypeScript lines and zero deleted lines across the seven scripts and dedicated test. Package metadata adds one dependency line and 93 lockfile lines. No existing test was deleted or moved.

I did not repeat mutation checks because source was frozen. Their reported failures remain implementation evidence supplied by the parent, not independent results from this round. I did not rerun typecheck, lint or the full check. The parent owns the full integration gate, including the separate transport fixture changes.

The known limits remain disclosed and do not block asking for narrowly scoped approval: SDK retries are retained; two logical creates do not prove an absolute allocation or dollar cap; image build/import work and cost are not hard bounded; credentials do not machine-verify the workspace label; requested provider lifetimes need live proof; app/image records remain; and the SDK has no public process reattachment API. The test suite does not prove provider idempotency, post-termination tag availability, scheduling behavior or the complete live supervisor sequence. Those are evidence to obtain within a future explicit approval, not claims made by this review.

Read repository `AGENTS.md`, round 1, the implementation note, `MODAL-PROBE.md`, unslop, PR review, TypeScript patterns, worktree and document guidance. The user's exact Markdown destination and single-file ownership take precedence over the document skill's generic storage workflow. No memory-derived code facts were used. No credentials/profiles were read, no runtime SDK import or provider/network/browser/Docker/service action occurred, and no delegation, commit, push or change to main was made. Only this report is a retained reviewer write.

## Frozen source receipt

Combined seven-script `implementationHash`: `8b2d50cd4168e79bf74bdc04840f2ee19c15548b59019fa032a1a88ae8ed342a`.

Dedicated test SHA-256: `acf2a31faaabe6a9c49b8b1d8d6f9c6c37761dc089903f26852c8de4cdcb98d8`.

These match the brief and were rechecked after source inspection and the focused suite. No actual target or approval exists in this review. Execution remains gated on Hatim's explicit scoped approval.
