# Modal provider probe preparation

Status: superseded. The probe implementation and its test were deleted from the repository on 2026-11-08 by owner decision; commit 844c871 still holds them. Earlier status: locally implemented and tested; all round 1 fixes passed fresh independent review with no blockers. Not approved or executed. Phase 1's accepted runtime checkpoint is `b02de1b`. The full staging rollout remains a separate later approval.

## Why this comes first

The public TypeScript SDK exposes sandbox identity lookup but no public process-reattachment API. A run-scoped sandbox may provide the shared filesystem required by parallel nodes, but reconnection and result recovery need live verification before committing to that adapter. This probe tests the provider contract with fixed synthetic commands. It is not an end-to-end cloud Loopy deployment.

The proposed cohort is two named sandboxes, requested sequentially in one explicitly selected Modal environment. The first has a requested lifetime of at most 120 seconds and tests sandbox reconnection, concurrent filesystem visibility and recovery of a saved result after dropping a client handle. The second has a requested lifetime of at most 15 seconds and tests provider-enforced timeout while the caller is absent. Resource requests are 0.5 physical CPU and 512 MiB memory, with matching limits where supported. Workload network access is blocked. No volumes, GPU, tunnels, workflow secrets, personal files or Cloudflare resources are involved.

Hatim selected workspace ID `ac-BBeoTn9zN1g9g3tJyxwPN2`. Hatim selected existing Modal environment `main`. This selection identifies the proposal and does not authorize calls. The workspace field records the supplied ID as the intended target; the SDK does not independently verify it against credentials. The final command, target manifest hash, source hashes, secret-input mechanism, resource names and cleanup sequence will be filled in from the reviewed implementation before asking for approval. No current draft flag or file counts as user approval.

## Local preparation and source findings

- Installed `modal@0.11.1` as an exact development dependency using Bun with lifecycle scripts disabled. Its transitive versions are in `bun.lock`. No SDK module was imported or client instantiated during this inspection.
- Inspected official SDK documentation in personal Chrome on 2026-10-22: https://modal.com/docs/sdk/js/latest/Sandbox and https://modal.com/docs/sdk/js/latest/ContainerProcess. Verified implementation details against `node_modules/modal/dist/index.js` and the shipped declarations.
- The SDK reads its profile file during module import, before explicit client credentials are applied. Live execution must be a separate child with `MODAL_CONFIG_PATH` pointing to a known empty file under the isolated worktree state root. It must not inherit a personal profile or endpoint override.
- `ModalClientParams` advertises `maxRetries` and `timeoutMs`, but version 0.11.1's constructor does not apply those fields. Its retry middleware defaults to three retries with an idempotency key. The probe must not claim that setting those constructor fields disables retries or establishes an overall deadline.
- The SDK defaults to the experimental V2 sandbox route. The proposed probe selects V1 explicitly. `fromName` with `includeTerminated: true` nevertheless uses the V2 lookup and does not fall back, so the V1 probe will use name lookup only while live and retained IDs for subsequent reconciliation.
- Sandbox creation first resolves/builds the image and waits for scheduling before returning its ID. A client-side watchdog cannot establish that a remote image import or pending create has stopped. Persist create intent before the call, retain ambiguous outcomes, never reissue create automatically, and report unresolved resources.
- Queried public image registry metadata without pulling or running an image. The proposed immutable reference is `oven/bun:1.4.0@sha256:5ff609364c049b54eb0ff560ec96319729a972078ef2c755d758f0c6ef89c2d6`. The index includes Linux amd64 and arm64 manifests.

## What approval will and will not establish

The code will bound application-level create calls, requested sandbox lifetimes, fixed commands and result sizes. These are not a hard monetary cap or proof of provider idempotency. Image import/build costs, scheduling and SDK/server retry behavior remain provider risks. The final proposal will state a small operator stop threshold separately from estimated compute.

A passing live probe would support the next adapter decision. It would not establish Cloudflare regional durability, general Modal compatibility, production isolation, long-running workflow recovery, complete staging deployment or permission to upload personal Loopy state. No main merge is authorized.

## Commands and proposed scope

Run from `/Users/hatim.shakir/projects/loopy/cloud-integration`. The offline command is available now. It requires the selected workspace and existing environment names, creates a private manifest and prints its hash. It does not load the Modal SDK or credentials.

```sh
bun --no-env-file scripts/cloud/modal-probe.ts plan \
  --workspace ac-BBeoTn9zN1g9g3tJyxwPN2 --environment main
```

The live commands are implemented but remain unapproved. `PLAN_ID` must identify the reviewed target manifest. `APPROVAL_FILE` must record Hatim's actual explicit approval, with its reference, exact manifest hash and target, expiry and permitted actions. Never create a record to bypass the approval gate. `TOKEN_PAIR_FILE` is an owner-only JSON file containing the explicitly selected workspace token pair; its values must stay out of chat and logs. No credential is needed to review this packet.

```sh
bun --no-env-file scripts/cloud/modal-probe.ts execute \
  --id PLAN_ID --approval APPROVAL_FILE --credentials TOKEN_PAIR_FILE
bun --no-env-file scripts/cloud/modal-probe.ts inventory \
  --id PLAN_ID --approval APPROVAL_FILE --credentials TOKEN_PAIR_FILE
bun --no-env-file scripts/cloud/modal-probe.ts stop \
  --id PLAN_ID --approval APPROVAL_FILE --credentials TOKEN_PAIR_FILE
```

The proposed approval would cover one execution of that exact plan, scoped inventory and termination of its two sandbox identities. It would permit one named app and public image import/build if needed. No environment creation, Cloudflare deployment, full Modal adapter rollout, personal-state migration or main merge is included. Existing app use requires its exact name and ID and an empty app. The default creates a uniquely named probe app.

The script records durable create intents before provider calls. Ambiguous creation is retained as unknown and is not repeated. A terminal first sandbox is required before the second create. Saved IDs, names and tags fence cleanup. Neither cleanup nor inventory creates resources. App and image records are retained; this command does not delete them. Their eventual removal needs exact resource identification and its own authorization.

The public SDK does not verify the workspace label against the credentials. The selected environment and saved app ID are checked, but wrong-workspace credentials with an equally named environment remain a risk. Workspace selection and an explicit credential handoff must be resolved before execution. The private T3 secret card returns a reference rather than a file; this CLI cannot consume that reference directly. Do not request a secret card until a supported private handoff to the executor is available.

## Cost assumptions and stop conditions

Using the Sandbox rates recorded from [Modal pricing](https://modal.com/pricing) on 2026-10-22, 135 requested sandbox-seconds at 0.5 physical core and 0.5 GiB total about $0.00311 in CPU and memory. This is arithmetic for the requested lifetimes, not a spending cap. It excludes image import/build, retained images, platform minimums, scheduling behavior and unexpected retries. SDK retries remain enabled and absolute allocation counts are unverified.

The implementation bounds two logical create calls, each process to a requested 12 seconds, returned process output to 2 KiB, and the local supervisor to 240 seconds. The sandbox lifetime requests are 120 and 15 seconds. Unknown creation, wrong identity, failed filesystem/result recovery, unconfirmed termination or failure to observe the provider timeout ends the probe and attempts scoped cleanup. Do not rerun a plan after partial execution. Inspect its journal and obtain any additional approval needed for unresolved resources. Provider budgets and stop enforcement remain unverified.

## Local verification

The corrected focused suite passed 18 tests with 145 assertions. It covers durable admission, ambiguous creation, identity-fenced cleanup, timeout observation, bounded output, sanitized workers and a real local Bun filesystem fixture. No test imports the Modal runtime or calls the provider. Before those fixes, the complete `bun run check` passed build, lint, both TypeScript configurations and 1,162 tests, with 3 skips and 5,298 assertions across 79 files. Log: `evidence/check-modal-probe.log`.

The exact target manifest and approval proposal are recorded below. Placeholder offline plans are not eligible to substitute for that target selection. See [implementation details](modal-probe-implementation.md) for the approval schema, SDK limitations and journal behavior.

The corrected journal publishes synced private temporary files with no-overwrite links and a directory sync. App admission lists both V1 and V2 sandboxes through the exact app ID. Fresh cleanup-only approval can bind a `cleanupImplementationHash` while retaining the original resource manifest and tags; it cannot authorize execute or verification. The current seven-script hash is `8b2d50cd4168e79bf74bdc04840f2ee19c15548b59019fa032a1a88ae8ed342a`. All earlier placeholder plans are obsolete.

After all three fixes, the full repository check passed again: 1,165 tests, 3 skips, zero failures and 5,342 assertions. Build, lint and both TypeScript configurations passed. Log: `evidence/check-modal-probe-final.log`. Fresh independent review passed with no blockers; see `modal-probe-review-2.md`.


## Exact proposed probe, awaiting explicit approval

Target: workspace ID `ac-BBeoTn9zN1g9g3tJyxwPN2`, existing Modal environment `main`. This is the Modal environment name, not permission to change the Git main branch. Hatim supplied both values. Neither target selection authorizes provider calls.

Plan ID: `eee517857013e3ff70f1a968`.
Manifest SHA-256: `373828259f067b6f88d01a9c61fea032a3d2137083a822de58b618a647474344`.
Reviewed implementation commit: `093ccd4926b2f5e1faf9870d7133400e16725078`.
Seven-script implementation SHA-256: `8b2d50cd4168e79bf74bdc04840f2ee19c15548b59019fa032a1a88ae8ed342a`.
Public manifest copy: [evidence/modal-probe-manifest.json](evidence/modal-probe-manifest.json).

The exact app is `loopy-cloud-probe-eee517857013e3ff70f1a968`. The two sandbox names are `loopy-probe-eee517857013e3ff70f1a968-recovery` and `loopy-probe-eee517857013e3ff70f1a968-lifetime`. Creation is sequential, and the first must be confirmed terminal before the second is requested. The app is new; any existing app under this name is refused. The pinned public Bun image and fixed commands are in the manifest and reviewed source. The environment is never created or modified.

Proposed authorization: one execution of this exact plan, required provider discovery reads, app creation and image import/build as needed, its two logical sandbox creates, fixed synthetic commands, inventory and identity-scoped termination. Approval also needs to acknowledge retained SDK retries, unknown image-build cost/outcome and the absence of automatic workspace-to-credential verification. The local command has a 240-second watchdog; this is not a cloud spending or allocation guarantee. App/image records are retained after sandbox cleanup. No personal state, workflow credentials, Cloudflare deployment, production cutover or Git main merge is included.

After fresh explicit approval and a supported private credential handoff, the commands will be:

```sh
bun --no-env-file scripts/cloud/modal-probe.ts execute \
  --id eee517857013e3ff70f1a968 \
  --approval "$PWD/.loopy/cloud-probe/eee517857013e3ff70f1a968/approval.json" \
  --credentials "$PWD/.loopy/cloud-probe/eee517857013e3ff70f1a968/credentials.json"
bun --no-env-file scripts/cloud/modal-probe.ts inventory \
  --id eee517857013e3ff70f1a968 \
  --approval "$PWD/.loopy/cloud-probe/eee517857013e3ff70f1a968/approval.json" \
  --credentials "$PWD/.loopy/cloud-probe/eee517857013e3ff70f1a968/credentials.json"
bun --no-env-file scripts/cloud/modal-probe.ts stop \
  --id eee517857013e3ff70f1a968 \
  --approval "$PWD/.loopy/cloud-probe/eee517857013e3ff70f1a968/approval.json" \
  --credentials "$PWD/.loopy/cloud-probe/eee517857013e3ff70f1a968/credentials.json"
```

No approval or credential file was created during preparation. The approval record must cite the actual approving user message, expire within 24 hours, and grant execute/inventory/stop against the exact manifest. This proposed execution is one-shot; failure does not authorize another plan or resource cohort. If ambiguous remote work remains after scoped stop, retain the journal and report it before requesting further action. Fresh cleanup-only approval can bind newly reviewed code without changing the original resource identity.

The offline planning command completed without SDK import or provider calls and reproduced the reviewed implementation hash. The final full check and independent review remain valid because only target documentation and a public manifest copy changed afterward.
