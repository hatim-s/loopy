# Modal probe implementation, local preparation only

Prepared on 2026-10-22 in `/Users/hatim.shakir/projects/loopy/cloud-integration`, branch `cloud-integration`, starting HEAD `b02de1b97300573891b020c5539690bf94a4e7ae`.

No cloud action is approved or performed. No SDK runtime import, SDK client construction, provider request, credential read, service startup, Docker command, browser action, commit or push was performed during this implementation. Modal was inspected as text in `node_modules/modal/dist/index.d.ts` and `index.js`. Parent-owned package, lock and planning changes were left alone. Existing runtime, host and public contracts are unchanged.

## Commands and entry points

Default behavior is an offline plan. Both target names are required and are labels supplied by the user, never inferred from a profile.

```sh
bun --no-env-file scripts/cloud/modal-probe.ts \
  --workspace USER_SELECTED_WORKSPACE --environment EXISTING_ENVIRONMENT
```

This writes a new private `.loopy/cloud-probe/<random-24-hex-id>/manifest.json`, prints the manifest and SHA-256 hash, and exits. It imports no Modal runtime code and reads no credentials or Modal profiles. It makes no network requests. `plan` is an optional explicit subcommand.

A fresh app name defaults to `loopy-cloud-probe-<plan-id>`. An existing app requires both `--app-name loopy-cloud-probe...` and `--expected-app-id ap-...`. Existing apps must have the exact expected ID and no Functions, Servers or running Sandboxes of either V1 or V2. App inspection uses public `experimentalList` scoped to that exact app ID. Creation and live name recovery remain explicitly V1. A fresh app name that already exists is rejected. App absence is checked before an exclusive, durable app-create intent. No environment is ever created.

The live commands below are implemented for a future approved run. They were not invoked. `APPROVAL_FILE` and `TOKEN_PAIR_FILE` must be absolute paths to explicit, owner-only regular files, with no symlinks. Nothing requests or imports a token from the shell, home directory or personal state.

```sh
bun --no-env-file scripts/cloud/modal-probe.ts execute \
  --id PLAN_ID --approval APPROVAL_FILE --credentials TOKEN_PAIR_FILE
bun --no-env-file scripts/cloud/modal-probe.ts inventory \
  --id PLAN_ID --approval APPROVAL_FILE --credentials TOKEN_PAIR_FILE
bun --no-env-file scripts/cloud/modal-probe.ts stop \
  --id PLAN_ID --approval APPROVAL_FILE --credentials TOKEN_PAIR_FILE
```

`inventory` makes only provider reads. `stop` terminates only sandbox identities recovered from the exact journal, target app, name and plan tags. Neither command creates resources. Neither deletes an app, image, volume or environment. The supervisor manages a local operation lock and empty config file for these commands.

Exported local interfaces are `plan`, `parseManifest`, `hash`, `authorize`, `implementationHash`, `Journal`, `execute`, `verifyLifetime`, `inventory`, `Gateway`, `Connect`, `Clock`, `payload`, `boundedText`, `workerEnvironment`, `watchChild`, `ModalGateway`, and the narrow typed `ProbeSdk` seam. The narrow gateway lets pure tests drive the durable boundaries without loading Modal. It is separate from the existing sandbox backend and workflow compilation path.

## Approval and credentials

An execute flag or subcommand supplies no authorization. A private record must describe fresh, prior user approval. Do not generate an approval record merely to satisfy the parser. The record is a local attestation linked to that approval, not a cryptographic verification of a chat message.

`approvalSchema` requires `approvedBy: "Hatim"`, an `approvalReference`, the exact `manifestHash`, `target` object, `appName`, ISO `approvedAt` and `expiresAt`, and explicit `actions`. Execute also requires stop permission. Approval lasts at most 24 hours. At execution start at least 240 seconds must remain. Inventory and stop require 30 seconds. Both uncertainty acknowledgements must be true: `acceptsUnverifiedWorkspaceIdentity` and `acceptsSdkRetriesAndUnknownImageBuildCost`.

The manifest hashes all seven implementation scripts as well as target, names, policy and image. Both supervisor and worker call the same authorization guard before credentials or SDK import. Execute and lifetime verification require execute authority and the original implementation hash. Verification uses a 30-second remaining approval reserve. Editing a script blocks further execution under the old manifest.

For cleanup after source changes, retain the ORIGINAL resource manifest, manifest hash, target, names and remote ownership tags. Obtain fresh user approval against that original manifest, with actions limited to `inventory` and/or `stop`, and add optional `cleanupImplementationHash` containing the newly reviewed implementation hash. Current code must match that separately approved hash. Any approval carrying this field must exclude execute. It cannot authorize execute or verify even when the original source is restored. Without this field, current code must match the original implementation hash. Never revise the resource manifest to update cleanup code and never rewrite remote ownership tags. The record still attests to real prior user approval; the tool never generates or renews it. Expired approval also requires fresh scoped approval.

The explicit token file schema contains only `tokenId` and `tokenSecret`. Files are checked for owner-only permissions and current UID, and are bounded to 16 KiB before JSON parsing. Token values are never printed, added to the journal, injected into sandbox environments or inherited through the child environment. Provider errors are replaced with fixed messages because SDK errors can contain request metadata. Stderr from the worker is discarded by the supervisor.

The public SDK has no supported workspace/account identity lookup here. Workspace text cannot prove where credentials point. The user must select workspace-scoped credentials for the intended workspace. The code enforces the named existing environment, exact expected app ID when supplied, and the journal's recorded app ID thereafter. An equally named environment in another workspace remains a real mismatch risk when credentials are wrong. This limitation must remain in the parent's approval packet.

## Probe sequence and local bounds

The plan labels speed `Standard`; SDK scheduling defaults are retained. It sets no experimental speed or placement options.

1. Publish each journal record by writing and syncing a unique private temporary file, linking it to the final name without overwrite, removing the temp link and syncing the directory. Await publication before any remote action. A killed writer can leave an ignored temporary file, but published JSON is complete. No damaged-journal compatibility or repair path is added because no live probe exists. Record exclusive durable execution admission. Check or create the one exact app. Record intent before any app-create call and save its returned ID. Every sandbox create first checks that same app ID and rejects a populated app.
2. Record the recovery sandbox intent, then make one logical create call with its fixed plan name and tags. Save the ID immediately when the SDK returns, before fetching tags or executing processes. CPU request and hard limit are both 0.5 physical core. Memory request and hard limit are both 512 MiB. Network is blocked. Maximum sandbox lifetime is 120 seconds.
3. Start two bounded processes sequentially without waiting for the first to finish. They exchange fixed files in that sandbox and each returns `shared-ok`. Each process has a 12-second provider timeout and the output reader caps returned data at 2,048 bytes. Fixture polling itself lasts at most five seconds. Stderr is discarded.
4. Record effect intent. Start a synthetic process that creates an exclusive effect file, writes one fixed line, waits one second, then atomically renames its fixed result file. Drop its process handle and detach the sandbox. Reconnect with a new SDK client using V1 live name lookup. Require the same sandbox ID and exact tags. A fresh bounded reader recovers and validates the effect and result files. It never restarts the effect. This tests file-based result recovery, not process reattachment.
5. Terminate the first sandbox and confirm terminal status by polling its saved ID. Only then record the lifetime sandbox intent and make its one logical create call with the same resource policy and a 15-second provider lifetime. Its main process sleeps for 300 seconds so a normal process exit cannot satisfy the timeout observation.
6. Exit the creating SDK worker process. The local supervisor waits 17 seconds with no SDK child alive. A separate approved worker uses `fromId` and requires provider exit code 124. Other exit codes and a still-running sandbox fail the lifetime check.
7. Always attempt exact journal-scoped cleanup in a separate worker, including after the create worker fails or its watchdog kills it. Poll up to 20 times over ten seconds per sandbox. Record termination only after a terminal poll. Cleanup accounts for both roles even when one lookup or identity check fails.

The external supervisor kills the initial worker after 170 seconds, gives verification 15 seconds and cleanup 30 seconds, and constrains children to a total local 240-second wall budget. Provider lifetimes are separate requests. Loss of the supervisor itself cannot guarantee a cleanup call or enforce a remote wall or billing cap. A stale `operation.lock` deliberately blocks further commands; investigate whether the old supervisor and child are gone before manually removing that lock. Never remove create-intent or execution-admission records to rerun a plan.

Two logical sandbox creates are permitted, one per name and sequentially. The code cannot prove an absolute provider allocation or dollar cap. No volumes, secrets, GPUs, tunnels, deployed user Functions, Cloudflare resources, personal data, compiled workflows or uploaded user bundles are used. The only code sent to sandboxes is the fixed synthetic command text in `modal-probe-gateway.ts`. The fixed public image is `oven/bun:1.4.0@sha256:5ff609364c049b54eb0ff560ec96319729a972078ef2c755d758f0c6ef89c2d6`.

## SDK limits retained in the implementation

- SDK 0.11.1 reads configuration at module import. Only the approved worker dynamically imports it, after verifying a known empty private worktree TOML file. The child environment explicitly sets `MODAL_CONFIG_PATH`, `MODAL_ENVIRONMENT`, `MODAL_SERVER_URL=https://api.modal.com:443` and `MODAL_SANDBOX_V2=false`. It omits `MODAL_PROFILE`, ambient tokens and all other inherited environment entries. `HOME` is not reassigned.
- V1 name lookup omits `includeTerminated`. In this SDK, setting that option unconditionally selects experimental V2 lookup without V1 fallback. Saved IDs use public `fromId`, tags and `poll` for terminal checks. A missing live name after an ambiguous create stays unknown, including after presumed lifetime expiry.
- `sandboxes.create` first awaits `image.build(app)` and later scheduling. It can allocate a sandbox or start image import/build before returning an ID. The supervisor deadline cannot cancel or establish completion of remote image work. The journal retains intent across failures, kill and missing lookup. Image import/build costs, image retention and app retention are unknown and outside sandbox lifetime math. Cleanup does not delete global or app/image resources.
- Constructor `maxRetries` and `timeoutMs` are not used as retry/deadline controls in the inspected implementation, so this code does not set them or claim they suppress retries. Unary retry middleware defaults to three retries and keeps an idempotency key within a call. Other task-router retry logic also exists. `maxThrottleWaitSecs: 0` disables the separate server throttle-wait path supported by the source; ordinary retries remain. No private gRPC client or retry internals are used. Named uniqueness and idempotency behavior need live proof. `strictAllocationCapVerified` and `sdkRetriesDisabled` are explicitly false in the manifest.
- There is no public exec-process ID recovery API. The probe recovers files inside the original sandbox. It cannot yet prove a staging adapter, per-attempt process reconstruction, cross-sandbox filesystem sharing, post-termination artifact access, isolation enforcement or cost enforcement.

## Verification performed

- `bun run typecheck`: passed both workspace and portable TypeScript checks.
- `bunx --no-install biome check scripts/cloud/modal-probe*.ts packages/loopy/_tests_/cloud-modal-probe.test.ts`: passed eight files.
- `bunx --no-install eslint scripts/cloud/modal-probe*.ts packages/loopy/_tests_/cloud-modal-probe.test.ts`: passed with no diagnostics.
- `bun test packages/loopy/_tests_/cloud-modal-probe.test.ts`: 18 passed, zero failed, 145 assertions. Tests use temporary homes, fake gateway identities and an injected clock. A small local Bun fixture tests actual concurrent file exchange and exclusive effect/result recovery. Another local child proves watchdog termination. No test imports the Modal runtime or calls a provider. New assertions cover an actual interrupted filesystem write followed by exact-name cleanup, all-version SDK method selection through the real gateway, and separately approved cleanup of original ownership tags with execution and wrong-hash denials.
- Mutation check: temporarily removing the durable execution-admission write made the duplicate-execute test fail at its expected `EEXIST` assertion. Restored the write and reran the passing scoped suite.
- Earlier placeholder offline plans and their hashes are obsolete after these fixes. They remain local evidence only and cannot authorize execution of current code. No replacement approval or real target was invented. The scoped CLI test generates its own temporary offline plan. Current implementation hash across the seven scripts is `8b2d50cd4168e79bf74bdc04840f2ee19c15548b59019fa032a1a88ae8ed342a`.

All owned files are additions; no existing tests were deleted or moved. The repository's ordinary test script discovers this file through `packages/loopy/_tests_`. The full `bun run check` was not rerun because this subtask permits scoped pure/local tests and forbids service startups. The parent still owns the full integration gate, final manifest proposal, approval packet and any future live acceptance. No actual provider guarantee follows from these checks.

## Round 1 implementation follow-up

Addressed the three blockers in `modal-probe-review-1.md` without changing its independent verdict or any parent packet, task or evidence file.

- Atomic exclusive publication replaces direct writes to final paths. A local child with a zero-byte file-size limit reaches publication, fails its write, and leaves no final created record. The existing durable intent then permits exact-name/tag recovery and confirmed termination without another create. An existing final record remains unchanged when another publication loses with `EEXIST`. The original duplicate-execute test still proves zero connections by the losing admission.
- Existing-app admission now inspects both sandbox versions through public `experimentalList`. The test exercises the actual `ModalGateway` with a narrow typed fake SDK whose V1 list is empty and whose all-version list returns a V2 sandbox. It rejects admission before create or process start, checks exact app/environment scope, and confirms V1 live-name lookup omits `includeTerminated`.
- Optional `cleanupImplementationHash` separates cleanup code approval from original resource identity. Tests approve changed cleanup code, inventory and stop the originally tagged resources, and preserve the original manifest hash. Cleanup-only approval rejects execute and verify under both original and changed source hashes. Mixed execute/cleanup approval, absent override for changed code and an incorrect cleanup hash are denied. Both runtime entry points enforce this shared guard.

Three mutation checks also failed as intended when individually restoring direct final-path writes, selecting the V1-only list, or requiring the old implementation hash for all cleanup. Source was restored after each check and the complete focused suite rerun. Standard speed, provider uncertainty and all local-only boundaries are unchanged. No tests were deleted or moved.
