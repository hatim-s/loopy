# Phase 2 approval readiness review

Reviewed on 2026-10-22. Verdict: phase 1 has no newly identified acceptance blocker in this planning review. Phase 2 is not ready for actual deployment approval. Its packet accurately calls the provider adapter, durable receipts, staging configuration and scripts unimplemented. Those are substantive prerequisites, not missing command substitutions.

The smallest next work is a local, reviewed staging implementation and an executable, bounded fixture rollout plan. Do not reopen the engine, implement personal-state migration or require remote-provider proof before permission to obtain that proof. No cloud action or main merge is authorized by this review.

## Snapshot and review boundaries

- Verified the requested directory and branch `cloud-integration`, initially at `214bbe3910ff65dc3eec6af31c187908e33246bc` with the transport harness and evidence as local changes.
- The parent advanced the branch during review to `b02de1b97300573891b020c5539690bf94a4e7ae`. Inspected its changed-file list. It commits transport scripts, the runbook, notes and evidence, with no runtime implementation changes relative to `214bbe3`. The checkout was clean before this report was added.
- Read the repository `AGENTS.md`, supplied instructions, `unslop`, review guidance, TypeScript guidance and patterns, worktree guidance, `PLAN.md`, `PHASE-2.md`, `EVIDENCE.md`, review 2, transport evidence and the relevant cloud/provider/host source. Classification remains a major feature. This is a deployment-planning review, not a new full implementation review.
- Only this report is owned and written by this reviewer. No source/test edits, tests, Docker commands, service requests, credentials, network calls, browsing, delegation, main operations, commits or pushes. Read-only Python compared file hashes and parsed saved evidence. Cost arithmetic below uses the packet's rates without verifying current provider prices or guarantees.
- The exact output path supplied by the parent takes precedence over the generic document skill's separate storage workflow.

## Phase 1 acceptance

The latest saved full-check log reports 1,147 passed, 3 skipped, 0 failed and 5,197 assertions across 78 files. See `evidence/check-transport-final.log:1386-1395` and `EVIDENCE.md:89-91`. The three skips are two Linux-only tests and the opt-in real-Docker test. Separate 13-test Docker coverage, the 11-check actual journey, the seven-check failure journey and authenticated dashboard acceptance are recorded in `EVIDENCE.md:35-50,70-86`. I inspected the saved results, not a rerun.

The two additional transport scenarios passed at the requested `214bbe3` snapshot. They preserve one admission/start, the original container and deadline, and report no remaining owned resources. Every file hash in that transport JSON matches the current checkout. The healthy daemon and same-process service-object reconstruction are explicit limits, not a substitute claim for daemon failure or Modal behavior. See `transport-proof.md:13-18,30-40` and `evidence/transport-failure.json`.

Review 2's 17 source fingerprints have two current mismatches, `apps/cloud/src/provider.ts` and `apps/cloud/src/artifact-route.ts`. I read both current files. The route still checks authenticated workspace and terminal run status, and the provider still uses bounded authenticated reads and validated wire results. No new blocker was found there, but the old fingerprints do not prove byte-for-byte review coverage of those two files. The transport hash set covers sandbox source, not these cloud files. The final full check is separate evidence, not a replacement for source review.

No demonstrated remaining phase 1 gap blocks the stated local delivery. Remote durability, Modal compatibility, production throughput, mobile browser coverage and personal workflows were not phase 1 acceptance promises. The earlier SSE timing failure remains disclosed in `EVIDENCE.md:56-58`; a later complete passing run exists. A broader investigation is not a prerequisite to preparing this packet.

## Findings that block deployment approval

### 1. Implement the selected provider and its durable admission state

`PHASE-2.md:29-31` proposes `ModalBackend` and `SandboxReceipts`. Neither exists. `apps/cloud/package.json` has no Modal or container integration dependency. `apps/sandbox/src/attempts.ts:36-62,143-163` constructs a filesystem `ReceiptStore`, takes a local process lock and starts a Docker-shaped backend. `apps/sandbox/src/receipts.ts:12-24` requires Docker container/input-volume/workspace-volume names. Merely adding a class named `ModalBackend` cannot make this service survive bridge replacement.

Smallest local fix: implement one chosen bridge path using the existing attempt wire API, with provider-specific durable internal records. Persist stable staging/workspace/run/execution-key/attempt identity, request hash, original deadline, admission state and subsequent Modal sandbox/process IDs. Use deployment identity instead of a bridge filesystem path in durable keys. Make admission and terminal publication conditional on the durable owner/state so a stale bridge cannot create or overwrite newer work. Serialize shared-workspace artifact export across replacement bridges as well as attempts. Reuse bundle validation, execution protocol and bounded result behavior.

The local diff must decide what happens between provider create and persistence of its response. A lost create acknowledgement must recover the same identity, or remain unrepeated and uncertain with orphan accounting. It must not return `none` or issue another create. A remote ID cannot literally be persisted before the provider assigns it, so implement an admission/create-intent boundary and a concrete recovery policy. A stub that always fails uncertain is not a completed provider implementation.

Local contract checks should cover duplicate/content-conflicting admissions, lost create/start responses, bridge replacement, stale completion, lost terminal writes, deadline recovery and artifact-read fencing. Real identity discoverability and provider enforcement remain post-approval checks.

### 2. Implement the staging entry, bindings and authentication together

`apps/cloud/src/worker.ts:11-21` rejects non-local stages and remote hosts before authentication. `apps/cloud/src/environment.ts:24-47` reads `LOCAL_AUTH` and permits only loopback HTTP provider URLs; `apps/cloud/src/provider.ts:25` uses that validator. The proposed `WORKSPACE_AUTH` secret has no consumer. `apps/cloud/wrangler.jsonc:3-19` contains only the local Worker, one Workspace class, local R2 name and localhost provider URL. It has no static assets or container bindings. `scripts/build.ts:23-37` builds dashboard assets but does not wire them into this Worker.

Smallest local fix: add an explicit staging configuration and entry/routing behavior, preserving local mode. Bind the built dashboard on the API origin with SPA fallback and API-first routing. Define the exact staging hostname and route, account selection, Workspace and receipt DO bindings/migrations, R2 binding, bridge controller class/binding, container image/entrypoint and instance limit. Confirm whether the selected container integration requires a further controller DO; the current resource list does not specify one. Keep preview URLs disabled and identify the chosen deployment's public entry explicitly.

For the initial owner-only fixture cohort, reuse a reviewed bearer-to-workspace mapping with fresh staging credentials. A full OAuth, Clerk or multi-user system is unnecessary. Parse the actual secret name once; preserve principal-derived workspace routing and origin checks. Define bridge authentication, private receipt RPC routing and bridge-only Modal credential injection. Pin SDK/image versions and explicitly inject credentials so no personal Modal profile is consulted. Worker/bridge control credentials must never reach workflow environments. Workflow secrets and full mode can remain disabled, as already implemented at `apps/cloud/src/workspace.ts:18-22,75-76`.

### 3. Replace the illustrative command list with bounded, executable operations

`PHASE-2.md:44-66` refers to absent `wrangler.staging.jsonc`, `provision-staging.ts` and `verify-staging.ts`. It also omits executable admission-stop, inventory and rollback operations. Names alone do not establish their scope or ordering.

Smallest local fix: implement and review those scripts and a short stop/inventory/rollback path. They should take one explicit staging manifest, reject wrong account/environment/resource names, refuse accidental reuse of populated unrelated resources, and record created IDs and completed steps. The manifest needs exact owner workspace, fixture definitions/count, CPU/memory requests, maximum active sandboxes/processes, provider-enforced lifetime, total verification deadline, retention interval and budget inputs. Scripts must not read personal state or auto-create missing resources outside that manifest.

`CONCURRENCY=2` limits running workflow records, not Modal sandboxes. See `apps/cloud/src/scheduler.ts:120-152` and `packages/loopy/src/host/durable.ts:159-175`. A wide graph can admit more attempts across turns; `maxWork=16` is also not a live-sandbox limit. Bound the approved fixture cohort and provider admission explicitly. This does not require a general billing system or an engine scheduler rewrite.

Before approval, show the exact ordered commands, selected config and image hashes, target account/environment, private secret input mechanism, expected outputs and stop conditions. Every remote invocation must use explicit account/config/environment selection. The draft R2 create command currently lacks the explicit config selection used by the deploy commands. Inspect the pinned tooling's first-deployment/secret bootstrap behavior and choose a fail-closed order; do not assume a Worker already exists. Include any image build/upload/registry resources and Modal image/app creation in the authorized actions.

The dry run's offline status is still unresolved in the packet. With container integration, do not label it resource/network-free until the selected tool path proves that property. Dependency installation may also use the network. Separate genuinely offline packaging from remote image/resource operations in the final sequence. None was run here.

### 4. Make rollback possible on the first deployment

`PHASE-2.md:87` assumes a previous Worker version. Fresh staging has none. Stop-new-admission and schedule disabling must exist before requesting deployment approval. Disabling the Worker or deleting receipts while a bridge still dispatches is not a safe substitute.

Smallest local fix: define a first-deployment stop/maintenance state and subsequent-version rollback commands. Stop new runs/provider admissions and disable schedules while allowing lookup, termination and receipt reconciliation to continue. Inventory every active or possibly active provider ID/create intent. Confirm termination before treating a timeout as safely retryable. Preserve DO/R2/receipts and unresolved orphan records. Roll back to a recorded compatible version only when one exists; otherwise leave the authenticated staging entry stopped. Do not suggest switching local services or a production hostname during this fixture rollout.

A general automatic garbage collector is unnecessary for the first bounded fixture cohort. Specify a fixed retention interval, an exact retained-resource report and a separately reviewed cleanup allowlist. Never expire a started receipt, or erase a deduplication record while its identity can still be submitted. If receipt payloads are later removed, retain an admission tombstone or reject those identities. This is narrower than solving production retention and migrations now.

## Resource and cost decisions needed in the packet

The proposed names are usable planning inputs, not verified available resources. `Workspace` and `SandboxReceipts` are class names, not already-created namespace IDs. The completed local manifest should specify:

| Proposed resource | Decision needed before approval |
| --- | --- |
| `loopy-cloud-staging` | Exact account, hostname/route, asset build path, staging entry and first-deploy stop behavior |
| Workspace and receipt DOs | Exact bindings/classes/migration tags, object identity policy and any separate container controller class |
| `loopy-staging-artifacts` | Explicit account, Standard storage choice and fresh fixture-only prefix/ownership policy |
| `loopy-modal-bridge-staging` | Actual container/controller configuration, one-instance limit, pinned image, startup/wake/idle behavior and authenticated routing |
| `loopy-sandboxes-staging` | Explicit Modal workspace/environment, pinned SDK/image, CPU/memory/lifetime and maximum active fixture work |
| Proposed run volumes | Chosen workspace model, retained IDs, lifecycle and costs; remove this resource from the manifest if the chosen design does not use it |

The packet's Modal arithmetic is correct on its stated assumptions: `10,000 * 30 * (0.5 * 0.00003942 + 0.25 * 0.00000667) = $6.41325`. Bridge excess is about `$0.7254` from `$0.675` memory and `$0.0504` disk, with no CPU excess at the stated 10% assumption and unused included allocation. These calculations do not establish that the selected provider accepts or bills exactly those resource requests.

The $25/month proposal is an estimate and alert target, not an enforced spend ceiling. Missing inputs include actual sandbox/run lifetime, volume storage, idle time for a run-scoped sandbox, image build/storage, bridge wake duration, controller/receipt DO traffic, alarms/polling, SSE and consumed account-wide allowances. Default local Docker CPU is 1 at `apps/sandbox/src/config.ts:25`, whereas the cost model assumes 0.5 physical core; the staging resource request must be explicit. No local measurement proves the proposed 100 bridge hours or 10% CPU.

Use a bounded initial fixture budget and a clear operator stop threshold. Record whether a provider actually offers an enforceable cap. Do not require building automated dollar-accurate metering for this small rollout, and do not promise a hard monetary cap from alerts. The parent owns fresh pricing/account/SDK documentation verification in personal Chrome. This reviewer made no current pricing or platform-guarantee verification.

## Does Modal uncertainty require changing the Docker attempt contract?

The public `none | started | finished` receipt union already carries failed `uncertain` results, at `packages/loopy/src/contract/sandbox.ts:38-52`. The host requires atomic deduplication and transport failures to throw rather than return `none`, at `packages/loopy/src/host/durable.ts:17-24`. It looks up before starting and protects a known started receipt from disappearance, at `durable-work.ts:66-83,113-130`. The engine retries `execution` and configured `exit` errors, not `uncertain`, at `packages/loopy/src/engine/retry.ts:7-8`.

Therefore no engine/public receipt change is justified by the current evidence. Reuse those semantics. The internal `AttemptBackend` at `apps/sandbox/src/docker.ts:30-36` accepts `StartedReceipt`, whose schema requires Docker resource names. That seam and the filesystem store must be adapted or kept Docker-specific beside a Modal implementation. Do not invent Docker-shaped names for Modal IDs or claim backend substitution alone is sufficient.

Preserve the distinction between transport uncertainty and confirmed termination. Keep admitted work started while reconciling temporary outages. A provider timeout may become retryable `execution` only after termination is confirmed. An unrecoverable execution identity can become terminal `uncertain`, with no automatic repeat, while any possibly live resource remains inventoried and its shared workspace quarantined until fenced. A missing or eventually visible provider lookup is not proof of absence.

The workspace promise is a separate issue. Docker mounts one run volume into parallel workers at `apps/sandbox/src/attempts.ts:150-153` and `docker.ts:160-163`. There is no Modal evidence for equivalent concurrent visibility. Before approval, choose one implemented strategy and state its assumptions. A run-scoped sandbox with bounded concurrent processes can avoid assuming cross-sandbox shared-volume coherence, but then process identity, per-attempt immutable input paths, reconstruction and retained artifact access need implementation. Explicit artifact exchange needs an equally concrete data flow. Neither alternative is free. Do not implement all strategies or weaken the existing filesystem promise silently.

## What can only be established after fresh approval

Local code and contract checks must be reviewable first. The following remain live verification gates. Their expected observations and failure actions must be encoded in the plan before approval:

- Actual Cloudflare account permissions, class/migration creation, bindings, hostname/assets/auth routing, container startup and alarm recovery after reconstruction.
- The pinned Modal SDK/image's runtime support, credential injection, sandbox/process identity recovery after lost responses, and no duplicate effects during retries or bridge replacement.
- Provider-enforced lifetime while the bridge is unavailable, confirmed termination, output recovery and correct uncertain outcomes.
- Sequential and parallel filesystem visibility for the chosen model, workspace isolation, safe network restrictions and artifact reads after reconstruction. A volume commit/reload guarantee must be demonstrated or documented by the parent, not inferred here.
- Resource inventory and cleanup behavior, actual retained storage and billed usage. Local workerd/Docker cannot establish regional durability, billing or Modal security parity.

Failure of a live gate stops the rollout before non-fixture admission. This first approval should cover only the named fresh synthetic cohort. Personal workflows, credentials, data migration and any production cutover need a later explicit scope. If the selected identity or filesystem strategy cannot be made concrete from available SDK evidence, narrow the next proposed approval to an exact bounded provider probe rather than calling an incomplete full deployment ready.

## Smallest next local work

1. Freeze the current accepted phase 1 snapshot and implement one staging Modal/receipt/bridge path with durable identities, deadlines, fencing and one chosen workspace strategy. Preserve the engine and local Docker behavior.
2. Add the separate staging configuration, asset routing and owner/bridge authentication. Pin dependencies and images. Keep workflow secrets disabled.
3. Implement the manifest-driven provision/verify/stop/inventory/rollback operations with bounded fixture resources, explicit remote scope and a first-deploy stop path. Specify retention and costs without building a production GC or billing service.
4. Review that local diff and run meaningful provider/durable-boundary checks plus `bun run check` in the parent's authorized local workflow. Establish which packaging commands are genuinely offline. Produce the exact approval packet with unresolved live checks clearly labeled.

Only then ask Hatim to approve those concrete cloud actions. This report neither requests nor supplies that approval. It adds no phase 1 implementation requirement and leaves the branch separate from main.
