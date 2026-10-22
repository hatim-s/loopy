# Loopy cloud integration, phase 1

Status: runtime implemented, verified and independently reviewed; authenticated dashboard QA passed; additional real Docker transport-failure verification passed. Owner: Astra top-level T3 thread. Updated 2026-10-22.

## Authorization and workspace

Worktree `/Users/hatim.shakir/projects/loopy/cloud-integration`, branch `cloud-integration`, base `dee31da64781c04313b2555a5e697da724e06ef8`. No main changes or merges. All cloud execution stays local. No remote Wrangler, Modal workloads, resource provisioning, migrations or personal state uploads. Phase 2 requires fresh explicit approval after evidence and a concrete plan.

Do not touch personal `~/.loopy` or existing services. In particular ports 4310 and 4173 belong to existing work. Fixtures, provider state and logs use this worktree's ignored `.loopy/cloud` directory. Docker resources carry a `loopy.sandbox.owner` label derived from the exact state root. The VM is named `loopy-cloud-phase1`. Use explicit Docker context, never change the user's default.

## Proposed implementation

1. Reuse the existing SQL store through a narrow synchronous driver. Keep local Bun SQLite and its existing data upgrades intact. Add a Durable Object SQLite driver using `transactionSync`, fully consuming SQL cursors before awaits. A workspace Durable Object owns schedules, runs, waits, attempt fencing and the event outbox so schedule fire and run insertion remain one transaction.
2. A Cloudflare Worker authenticates requests and routes each configured bearer principal to its workspace Durable Object. Clients cannot select another workspace by editing a query or body. Use the existing contract and dashboard views. Immutable revisions, executable bundles and source artifacts live in locally emulated R2. Publish the registry pointer only after verified artifacts exist.
3. Durable Object alarms drive bounded reducer work and reconcile external receipts. Persist node dispatch before contacting the executor. Do not depend on a long-lived in-memory daemon or an HTTP request remaining alive. Retry deadlines retain activation capacity; waits and sleep release it. An alarm is a wakeup hint, with SQL state determining due work.
4. A local Bun execution service implements a provider-neutral attempt API. Docker containers execute only compiled bundles and descriptor commands with an isolated per-run workspace. Durable receipts deduplicate attempts. Started attempts with missing workers become uncertain, never automatic repeats. No host home, credentials or Docker socket inside execution containers. Docker stands in for Modal; it does not prove Modal lifecycle or security parity.
5. Run the existing dashboard against the actual emulated API and synthetic fixtures. Compile on the local trusted client, transfer compiled artifacts, and exercise branches, maps, parallel execution, retries, waits, logs and schedules.

## Acceptance work

Run baseline and final `bun run check`. Add meaningful transaction and provider-boundary tests. Run Wrangler locally with persisted DO SQLite and R2, plus Docker. Verify restart recovery, duplicate and late completions, stale owner fencing, killed workers, timeouts, schedule overlap, input validation, revision pinning, bounded query/payload reads, SSE reconnect and retention, authentication and workspace isolation. Record commands, versions, resource ownership, outcomes and limits in `EVIDENCE.md`.

Independent Sol review rounds must use new delegated task IDs. Resolve substantive findings before declaring phase 1 complete. Green unit tests alone do not establish end-to-end or platform correctness.

## Phase 2 gate

Prepare exact resources, configuration and deployment commands; cost assumptions; auth/secrets; fresh-state versus migration choice; rollback and verification. Do not execute them. Approval to deploy will not authorize a main merge.

## Platform evidence

Cloudflare SQLite storage documentation was read in Hatim's personal Chrome on 2026-10-22: https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/

It documents synchronous SQL transactions, automatic input/output gates, cursor consumption before awaits, and local PITR absence. Local tests cannot establish remote durability, failover timing or PITR.

## Current continuation

Authenticated personal Chrome QA passed on 2026-10-22. Additional Docker transport-failure verification passed in isolated resources under `.loopy/cloud-transport`; cleanup was verified and the existing fixture stack remains available. New Sol tasks use Standard speed, `serviceTier: default`, as requested by Hatim. Retain earlier task settings as historical records. The phase 2 packet still needs its staging implementation prerequisites resolved before a deployment approval request.
