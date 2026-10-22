# Phase 2 approval packet, draft

No cloud action is authorized. This packet does not request approval until phase 1's final check and dashboard acceptance are complete. The branch stays separate from main even after cloud approval.

## Proposed first cloud scope

Start with fresh synthetic state in a staging environment. Do not upload `~/.loopy`, import personal receipts, copy local credentials or migrate running workflows. The local daemon remains usable on its current ports and configuration.

Use these resource names, subject to the account owner confirming availability:

| Resource | Name and purpose |
| --- | --- |
| Cloudflare Worker | `loopy-cloud-staging`, authenticated API and dashboard static assets on one origin |
| SQLite DO namespace | `Workspace`, one object per authenticated workspace; existing schema and alarms |
| R2 Standard bucket | `loopy-staging-artifacts`, immutable compiled graphs, bundles and source |
| SQLite DO namespace | `SandboxReceipts`, durable provider admissions, Modal IDs and terminal receipts |
| Cloudflare Container | `loopy-modal-bridge-staging`, one `basic` instance running the Bun TypeScript Modal adapter |
| Modal app | `loopy-sandboxes-staging`, safe CPU-only sandboxes, no GPU requests |
| Modal volumes | `loopy-staging-<workspace-hash>-<run-id>`, retained run workspaces with explicit lifecycle cleanup |

D1, KV, Queues and a separate cron service are not needed for the current atomic boundaries. Workspace alarms own scheduling. The bridge has no durable authority in its container filesystem. Receipt state belongs in its DO and survives bridge replacement. This is an adapter change around the existing engine and attempt contract, not a replacement engine.

The official Modal TypeScript SDK supports Bun, Node 22+ and Deno. Its documentation does not promise Workers compatibility, so this plan uses a Bun bridge rather than assuming it bundles into workerd. The SDK remains beta. [Modal SDK reference](https://modal.com/docs/sdk/js/latest), [JavaScript SDK scope](https://modal.com/docs/guide/sdk-javascript-go).

## Code required before the first deployment

These files and commands are planned, not present or executed. Cloud approval should authorize the staging rollout only after the following code has a reviewed local diff and passing contract tests.

1. Add a `ModalBackend` behind the existing asynchronous attempt contract. Pin an exact `modal` package version and a Bun worker image digest. Use explicit injected credentials so the SDK never reads a personal profile. Persist admission and provider identity before starting effects. A lost create response must reconcile by a stable provider identity or stop uncertain; it must not create a second sandbox.
2. Replace bridge filesystem receipt writes with `SandboxReceipts` DO RPC. Reuse exclusive admission, request-hash conflict and terminal fencing semantics. A container restart must never produce `none` for admitted work. Keep deadlines durable and allow the workspace alarm to trigger reconciliation when the bridge is asleep.
3. Validate Modal shared-volume commit/reload semantics for parallel nodes. Docker's shared writable volume is not proof that separate Modal sandboxes see the same writes. If the provider cannot provide that contract, use one sandbox per run with bounded concurrent processes or explicit artifact exchange. Do not silently accept weaker filesystem behavior.
4. Add a separate `apps/cloud/wrangler.staging.jsonc`. It must not inherit local tokens or localhost provider URLs. Configure same-origin dashboard assets, DO migrations, R2 binding, the bridge container, concurrency 2 initially, HTTP limits and disabled public preview URLs. Keep local configuration unchanged.
5. Add workspace-scoped authentication for the staging owner and explicit service-to-service authentication. Use Workers secrets for the Modal token pair and bridge authentication, injected only into the bridge. Workflow secrets remain disabled for the initial fixture rollout. Do not broaden network access for workflows to reach the Modal control API.
6. Add provider kill switches and retained-resource reporting. Stop new admissions and disable schedules before removing resources. Running effects must finish or be reconciled uncertain. Add bounded artifact/receipt retention, with deletion only after a separately reviewed retention policy.

The initial live verification must establish sandbox identity recovery, provider deadlines, volume visibility and resource cleanup before any personal workflow is admitted. These are the main remaining provider risks.

## Approval-time inputs and command sequence

The approval must identify the Cloudflare account, Modal workspace/environment, staging hostname, initial allowed user/workspace, spending ceiling and retention period. Credentials are entered through a private secret mechanism, never chat. Account-scoped tokens should be limited to this Worker, its DOs/containers and its R2 bucket where the providers support that scope.

After the code above is reviewable, the concrete command sequence is:

```sh
# Local verification first. No resources created by these commands.
bun install --frozen-lockfile
bun run check
bunx --no-install wrangler deploy --dry-run \
  --config apps/cloud/wrangler.staging.jsonc --outdir .loopy/cloud/staging-bundle

# Remote commands below require Hatim's fresh explicit approval.
bunx --no-install wrangler r2 bucket create loopy-staging-artifacts
bunx --no-install wrangler secret put MODAL_TOKEN_ID \
  --config apps/cloud/wrangler.staging.jsonc
bunx --no-install wrangler secret put MODAL_TOKEN_SECRET \
  --config apps/cloud/wrangler.staging.jsonc
bunx --no-install wrangler secret put SANDBOX_TOKEN \
  --config apps/cloud/wrangler.staging.jsonc
bunx --no-install wrangler secret put WORKSPACE_AUTH \
  --config apps/cloud/wrangler.staging.jsonc
bun --no-env-file scripts/cloud/provision-staging.ts
bunx --no-install wrangler deploy --config apps/cloud/wrangler.staging.jsonc
bun --no-env-file scripts/cloud/verify-staging.ts
```

The two staging scripts must be implemented and inspected before approval. Provisioning creates only the named Modal app and worker image; verification creates only tagged fixture sandboxes/volumes. No current script implements these remote actions. The dry run also needs to be rechecked for the selected Wrangler/container integration before it is used, rather than assuming all image handling is offline.

No automatic CI deploy is proposed. Record the approved configuration hash, image digest, resource IDs, deployed version and verification evidence before admitting any non-fixture work.

## Cost assumptions

Prices read from official pages in personal Chrome on 2026-10-22. Recheck at approval. These are estimates, not a spend cap; account-wide free allocations may already be consumed.

- Workers Paid starts at $5/month. DOs include 1 million requests and 400,000 GB-s/month, then $0.15/million requests and $12.50/million GB-s, rounded by billing unit. SQLite includes 25 billion rows read, 50 million rows written and 5 GB-month, then $0.001/million reads, $1/million writes and $0.20/GB-month. Persistent SSE connections and pending I/O can keep objects billable. [DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/).
- R2 Standard includes 10 GB-month, 1 million Class A and 10 million Class B operations/month. Excess is $0.015/GB-month, $4.50/million Class A and $0.36/million Class B, with free egress and billing-unit rounding. [R2 pricing](https://developers.cloudflare.com/r2/pricing/).
- Modal Sandbox CPU is listed at $0.00003942 per physical-core-second and memory at $0.00000667/GiB-second. At 10,000 attempts/month, 30 seconds each, 0.5 physical core and 0.25 GiB, compute is about $6.41 before credits, startup, bridge time or resource bursting. Longer timeouts and live sandboxes dominate this estimate. Do not apply the cheaper preemptible Function rate to Sandboxes. [Modal pricing](https://modal.com/pricing).
- A Cloudflare `basic` bridge provides 0.25 vCPU, 1 GiB memory and 4 GB disk. Included allocations are 25 GiB-hours memory, 375 vCPU-minutes and 200 GB-hours disk. Excess rates are $0.0000025/GiB-second, $0.000020/vCPU-second and $0.00000007/GB-second. At 100 active hours/month, 10% of allocated CPU on average, the estimated excess is about $0.73. Always-on memory/disk costs more even when CPU is idle. Container controller DO and request costs are additional. [Containers pricing](https://developers.cloudflare.com/containers/pricing/).

For the stated small workload, reserve a $25/month staging budget initially, with alerts below that threshold and short maximum attempt deadlines. This is a proposed budget for approval, not permission to spend it. Measure actual request counts, row reads/writes, alarm rate, active duration and sandbox lifetime during the first fixture run. No production throughput or cost claim follows from the local suite.

## Fresh state, cutover and rollback

Fresh staging state is the recommended choice. A later migration must separately inventory definitions, historical graphs/bundles/source, secrets, SQLite state, receipts and workspace files. Copying only SQLite is insufficient. Never migrate a live started receipt without a provider reconciliation plan. Migration and secret transfer require a separate explicit scope.

Cutover begins with synthetic fixtures only and schedules disabled. Verify auth, workspace denial, revision pinning, approval, retries, logs/SSE retention, artifacts, worker termination and service reconstruction on the actual providers. Then run two overlapping scheduled fixtures and disable them. Inspect resources and billing before accepting personal workloads.

Rollback stops new admission and disables schedules, records active provider IDs, reconciles all started attempts, and routes the staging hostname back to the previous recorded Worker version. Keep both R2 data and DO namespaces intact. A Worker version rollback does not undo SQL schema changes; use additive schema changes during the initial rollout. Keep the local setup running independently. Do not delete the staging resources as the first rollback action, and do not replay uncertain effects to make dashboards look complete.

## Gate

Pending before this packet is ready for approval: final phase 1 check, dashboard acceptance and a concrete reviewed staging-adapter/configuration diff. No approval has been requested or inferred. No cloud resource, remote migration, deployment or paid workload has run from this branch.
