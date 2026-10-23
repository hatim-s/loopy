# Documentation correction, round 2

Addressed D1 and D2 from `tooling-review-2.md`. Changed only the four assigned documents and added this report. Runtime behavior, source, configuration and tests are unchanged by this lane.

## Corrections

- Centralized test gate roots and fixture isolation in `AGENTS.md#tests-and-isolation`. CONTRIBUTING and both app READMEs link there.
- Described `packages/loopy/_tests_/fixtures/quality-test-root.ts` as the allocator for repository-local fixture state, including its unique directory and project marker. Explicitly noted that older suites still use temporary directories or `.loopy/architecture-tests`.
- Kept home injection, sanitized child environments, TMPDIR restrictions, port 0 and teardown guidance in AGENTS as verification-run guidance. Removed campaign roles and vocabulary from durable docs.
- Kept the filesystem decoder's retained-data reason and exit condition in the sandbox README, and summary repair's reason and exit condition in the cloud README. AGENTS and CONTRIBUTING point to those owners. Existing native SQLite preservation behavior remains documented.
- Corrected the sandbox factory contract: it is optional and defaults to filesystem authority. DO-backed callers pass a custom factory. The selected factory still runs after root validation and process-lock acquisition.

## Static verification

Read the fresh review and current documents. No application source was imported or executed. No tests, typechecks, broad checks, Docker, services or cloud calls ran. No retained datasets, private configuration or historical evidence were accessed or changed.

- `git diff --check -- AGENTS.md CONTRIBUTING.md apps/cloud/README.md apps/sandbox/README.md` exited 0 with no output.
- A read-only `python3 -I -` document validator passed for all four files. It checked Markdown fences, local link targets and heading anchors, centralized test guidance, owning README pointers, absence of campaign terminology/personal absolute paths/em dashes, accurate allocator qualification and the optional/default-filesystem factory wording.
- A read-only `python3 -I -` snapshot comparison produced the exact round-two diff below. This comparison uses the four documents as they stood at the start of this round, rather than conflating the earlier edits with this follow-up.
- `git diff --numstat -- AGENTS.md CONTRIBUTING.md apps/cloud/README.md apps/sandbox/README.md` printed final cumulative counts of 29/7, 13/10, 38/4 and 25/7 respectively, totaling +105/-28 against HEAD.
- Final hash verification passed for all four documents. An initial report whitespace assertion flagged the required space prefixes on blank unified-diff context lines. Restricting that assertion to report prose passed while preserving the exact patch.

## Round-two delta

| File | Added | Deleted |
| --- | ---: | ---: |
| `AGENTS.md` | 9 | 5 |
| `CONTRIBUTING.md` | 2 | 2 |
| `apps/cloud/README.md` | 4 | 2 |
| `apps/sandbox/README.md` | 7 | 3 |
| Total | 22 | 12 |

Production source delta: +0/-0. Tests moved/deleted: none. This new report is separate from the four-document totals.

## Stable handoff

The four documents are complete and will remain unchanged after this handoff. No commit or push was made. The ongoing fullcheck belongs to the coordinating agent and was not interrupted or duplicated.

| File | Final SHA-256 |
| --- | --- |
| `AGENTS.md` | `59667d10bbbca227482d3638b840942633647557d5ef179e01751afb6a64a503` |
| `CONTRIBUTING.md` | `c796de711674aa8fbaa979c2db3439edbfe2b598931b5ac4e07e34f5506aba99` |
| `apps/cloud/README.md` | `6c03479b07d19bdae55294523f8e2107b4f19ff2ba0ea3e00e1a8ea707a4ada0` |
| `apps/sandbox/README.md` | `3902a056c90ccdf7246fc8ae7de078419989dcab13ec5280490b29d397592074` |

## Exact round-two diff

```diff
--- round1/AGENTS.md
+++ round2/AGENTS.md
@@ -34,7 +34,7 @@
               isolated local-daemon workload comparison.
 ```
 
-The test gate includes `packages/loopy/_tests_`, `apps/dashboard/_tests_` and `scripts/playground/_tests_`. Shared test fixtures stay under their owning test root. The real workflows in `examples/` use the removed step SDK. PR 7 owns their migration; they are outside semantic TypeScript checking until then. Graph example fixtures remain compiled and checked.
+The real workflows in `examples/` use the removed step SDK. PR 7 owns their migration; they are outside semantic TypeScript checking until then. Graph example fixtures remain compiled and checked.
 
 The public entries are `loopy` and `loopy/graph` for the builder, `loopy/engine` for the reducer, `loopy/local` and `loopy/contract`. The old runtime entry and executable step SDK are deleted. The dashboard imports only `loopy/contract`.
 
@@ -58,7 +58,7 @@
 - `contract/` owns the shared wire shapes. Logs retain a per-run sequence for HTTP cursors and use execution key, attempt and index for identity. Schedules use `version` for optimistic concurrency; `revision` names graph hashes.
 - `local/server/` owns authenticated HTTP, SSE replay and live transaction delivery. `local/daemon-file.ts` owns daemon discovery.
 - `apps/cloud/src/` composes portable service and durable host with workspace SQL and R2 artifacts. Receipt authority owns session epochs, attempt records and export exclusion in a separate DO; verified immutable results live in R2. See the app README for bindings and local-only configuration.
-- `apps/sandbox/src/` composes explicit authority, result storage, backend and artifact reader dependencies after acquiring its process lock. Admission persists before Docker work. Monitoring reconciles started attempts without repeating them. Export guards remain until owned-helper removal is confirmed. The CLI selects filesystem authority; the architecture playground injects DO authority.
+- `apps/sandbox/src/` composes authority, result storage, backend and artifact reader dependencies after acquiring its process lock. Admission persists before Docker work. Monitoring reconciles started attempts without repeating them. Export guards remain until owned-helper removal is confirmed. The default factory selects filesystem authority; the architecture playground passes a custom factory for DO authority.
 
 ## Patterns to follow
 
@@ -70,10 +70,14 @@
 
 The reducer accepts time through events and performs no I/O, clock reads or randomness. Persist an execution before dispatch. Fence completions by execution key and attempt and writes by owner token. Never repeat an effect with a started receipt. Reconcile it first.
 
-Tests cover core transitions and durable boundaries. Use temporary homes and injected executors and clocks. Keep server, SSE, schedule and CLI tests passing when contracts change. Remove tests for deleted behavior with their implementation. Do not add compatibility paths or migrations for discarded databases.
+Do not add compatibility paths or migrations for discarded databases. Retained filesystem receipt compatibility and its exit condition belong to the [sandbox README](apps/sandbox/README.md#retained-data). Cloud summary repair and its exit condition belong to the [cloud README](apps/cloud/README.md#retained-data). See the cloud README for the phase 2 approval boundary.
 
-For bounded quality work, allocate fresh disposable state under `.loopy/quality-tests/<unique>`. Mark each fixture project with `.loopy/loopies`, inject its Loopy home and sanitize child environments so registry lookup cannot select an ancestor or personal home. Do not set global `TMPDIR` for legacy sandbox tests. Use isolated state and port 0 for ephemeral Bun/Miniflare servers. Dispose owned processes before removing only that fixture's state. Keep historical evidence separate from disposable test output.
+## Tests and isolation
 
-Retained datasets are consumers. Keep legacy filesystem receipt decoding until every retained root has a verified migration or explicit retirement, with started attempts and export guards reconciled. Keep cloud summary repair until every retained workspace's current pointers have generation-matched projections. Native SQLite 13/14 upgrades remain necessary while retained homes use them; remove that support only after verified migration or retirement of those homes. Never erase records to satisfy these exit conditions. Phase 2 cloud resources, Modal execution and personal-data migration remain unapproved and require separate authorization.
+The test gate includes `packages/loopy/_tests_`, `apps/dashboard/_tests_` and `scripts/playground/_tests_`. Shared test fixtures stay under their owning test root. Tests cover core transitions and durable boundaries. Use temporary homes and injected executors and clocks. Keep server, SSE, schedule and CLI tests passing when contracts change. Remove tests for deleted behavior with their implementation.
+
+Tests that need repository-local state use `packages/loopy/_tests_/fixtures/quality-test-root.ts`. It creates a unique child of `.loopy/quality-tests` with its own `.loopy/loopies` project marker, preventing ancestor registry selection. Older suites still use temporary directories or `.loopy/architecture-tests`; the helper has not replaced every allocator.
+
+For verification runs, inject fixture Loopy homes and sanitize child environments to prevent personal-state access. Give fixture projects explicit registry markers. Do not set global `TMPDIR` for legacy sandbox tests. Use isolated state and port 0 for ephemeral Bun/Miniflare servers. Dispose owned processes before removing only that fixture's state. Keep historical evidence separate from disposable test output.
 
 PR 4b owns control and value nodes. PR 4c owns waits, sleep, cleanup, rescue and active cancellation. PR 5 owns the dashboard adaptation and the local-to-host rename. Preserve these boundaries and concurrent user work.

--- round1/CONTRIBUTING.md
+++ round2/CONTRIBUTING.md
@@ -6,7 +6,7 @@
 
 Core, engine, contract and service stay portable. The portable typecheck, browser-bundle test and architecture test enforce these boundaries. The SDK imports core and builds graph data without executing author work. Service owns mutations, schedules and views over injected stores and registries. Local composes service, host, store and executor with paths, subprocesses, sandboxing and secrets. Cloud composes the same service and durable host with workspace SQL/R2 adapters and a sandbox provider. See the [cloud](apps/cloud/README.md) and [sandbox](apps/sandbox/README.md) READMEs for receipt authority modes.
 
-The test gate covers `packages/loopy/_tests_`, `apps/dashboard/_tests_` and `scripts/playground/_tests_`. Test type guarantees, parsers, sandbox confinement, durable transitions and CLI behavior with temporary homes and injected executors. Give fixture projects explicit `.loopy/loopies` markers to prevent ancestor registry selection. For bounded quality runs use fresh `.loopy/quality-tests/<unique>` state, injected homes and sanitized child environments; leave global `TMPDIR` alone for legacy sandbox tests. Remove only owned disposable state after teardown. Skip tests for glue.
+Follow [AGENTS.md](AGENTS.md#tests-and-isolation) for test roots, fixture isolation and teardown.
 
 Host and store invariants:
 
@@ -19,4 +19,4 @@
 - Native SQLite schema 15 upgrades retained 13/14 homes without dropping records or changing the epoch. Other populated unsupported schemas fail closed and must be preserved for migration. Do not recreate tables as an upgrade strategy.
 - Sandbox execution fails closed.
 
-Retained receipt decoding and cloud summary repair protect accepted persisted data. Their removal requires verified migration or explicit retirement of every affected root/workspace, including generation-matched summary projections and reconciled attempts/guards. Preserve historical evidence. Phase 2 cloud resources, Modal workloads and personal-data migration require separate approval.
+See the [sandbox README](apps/sandbox/README.md#retained-data) for retained receipt compatibility and the [cloud README](apps/cloud/README.md#retained-data) for summary repair. The cloud README also defines the phase 2 approval boundary.

--- round1/apps/cloud/README.md
+++ round2/apps/cloud/README.md
@@ -54,7 +54,7 @@
 
 The transport journey opens no ports. It kills an actual Docker wait client and directs selected inspect/list calls to an absent socket while the owned worker keeps running. It checks original-container reconciliation, duplicate admission and the persisted timeout deadline, then removes only its receipt-derived resources. State remains under `.loopy/cloud-transport`. The shared Docker daemon and fixture stack stay available. This proves invocation-scoped CLI failures, not a Docker daemon outage.
 
-The default test gate includes `packages/loopy/_tests_`, `apps/dashboard/_tests_` and `scripts/playground/_tests_`. For bounded quality work, use fresh `.loopy/quality-tests/<unique>` state, explicit `.loopy/loopies` project markers, injected homes and sanitized child environments. Leave global `TMPDIR` unchanged for legacy sandbox tests. Ephemeral Bun/Miniflare servers can use port 0 with isolated state. These checks do not require starting the retained stack or Docker. Root integration owns the full check gate.
+See [AGENTS.md](../../AGENTS.md#tests-and-isolation) for test roots and fixture isolation.
 
 ## Receipt authority and configuration
 
@@ -97,7 +97,9 @@
 
 This stops compute and retains state for the next start. Stopped containers and named volumes are intentional inspection evidence. It is not a data reset. Do not run `docker system prune`, remove receipt/result/export/session records, delete the whole Colima profile or erase Wrangler state as routine teardown. Losing admission records can permit re-execution; losing result files breaks terminal reads; losing export guards can release a volume before helper cleanup. Resource cleanup must derive an exact allowlist from this authority's records, verify ownership labels and confirm each removal, as the failure journey does. Preserve the records when removing container resources. Stop only the identity-verified stack you own; an occupied port never authorizes stopping another service.
 
-Legacy filesystem receipt decoding remains because accepted local datasets contain the earlier flat records with inline results. Remove it only after every retained root has a verified migration or explicit retirement and all started attempts/export guards are reconciled. Cloud summary repair likewise serves pointers saved before summary projections existed. Remove that path only after every retained workspace's current pointers have generation-matched projections. Preserve publication generation fences and historical evidence throughout; deleting data is not migration.
+## Retained data
+
+Cloud summary repair serves accepted pointers saved before summary projections existed. Remove that path only after every retained workspace's current pointers have generation-matched projections. Preserve publication generation fences and historical evidence throughout; deleting data is not migration. Filesystem receipt compatibility belongs to the [sandbox README](../sandbox/README.md#retained-data).
 
 ## Runtime boundaries
 

--- round1/apps/sandbox/README.md
+++ round2/apps/sandbox/README.md
@@ -32,7 +32,7 @@
 
 The architecture playground injects `HttpSandboxAuthority` backed by the Worker's `SANDBOX_RECEIPTS` DO and `RECEIPT_RESULTS` R2 bucket. The default playground profile remains filesystem-backed. DO sessions persist epoch and nonce, fencing writers from earlier bridge processes. Receipt SQL owns admission, terminal pointers and export guards; R2 owns immutable result bytes. The sandbox CLI has no DO-mode flag.
 
-Programmatic callers pass an explicit dependency factory to `startSandbox(config, createDependencies)`. The coordinator validates the state root and acquires its process lock before invoking that factory, then opens a session and reconciles persisted work. Supply authority, matching result storage, execution backend and artifact reader together. A durable harness rejects populated filesystem receipts/exports when selecting DO authority; use a fresh root rather than switch an existing dataset in place.
+The dependency factory in `startSandbox(config, createDependencies)` is optional; omitting it selects filesystem authority. DO-backed callers pass a custom factory supplying authority, matching result storage, execution backend and artifact reader together. The coordinator validates the state root and acquires its process lock before invoking the selected factory, then opens a session and reconciles persisted work. A durable harness rejects populated filesystem receipts/exports when selecting DO authority; use a fresh root rather than switch an existing dataset in place.
 
 The local Worker bridge uses `POST /internal/sandbox-receipts`. DO composition requires `RECEIPTS_TOKEN`, `RECEIPTS_NAMESPACE` and `RECEIPTS_ROOT`, with matching client credentials and namespace. The namespace/root pair is fixed in receipt SQL. The bridge token must differ from user principal tokens. `SANDBOX_RECEIPTS`, `RECEIPT_RESULTS` and the `v2-receipts` migration are declared in the [cloud configuration](../cloud/README.md#receipt-authority-and-configuration). Keep generated private config and credentials out of output and commits.
 
@@ -98,9 +98,13 @@
 
 Keep admission, result, session and export records when removing container resources. Deleting admission records can permit re-execution; deleting result blobs breaks terminal reads; deleting guards can release a volume prematurely. In DO mode, preserve the matching Wrangler SQL/R2 state and namespace/root configuration as well as the bridge root. Do not erase retained datasets or historical evidence as routine teardown.
 
-Legacy flat filesystem receipts with inline results remain readable because accepted datasets still use them. Remove that decoder only after every retained root has a verified migration or explicit retirement, including reconciliation of all started attempts and export guards. These local tests do not authorize phase 2 cloud resources, Modal workloads or personal-data migration; those remain behind separate approval.
+## Retained data
 
-Boundary suites live under `packages/loopy/_tests_`; the repository gate also includes dashboard and playground `_tests_` roots. For bounded quality work, use fresh `.loopy/quality-tests/<unique>` state, explicit `.loopy/loopies` project markers, injected homes and sanitized child environments. Do not set global `TMPDIR` for legacy sandbox tests. Use port 0 and isolated state for ephemeral Bun/Miniflare servers, and remove only owned disposable output after teardown. Run the boundary tests without Docker:
+Legacy flat filesystem receipts with inline results remain readable because accepted datasets still use them. Remove that decoder only after every retained root has a verified migration or explicit retirement, including reconciliation of all started attempts and export guards. Preserve historical evidence; deleting data is not migration. See the [cloud README](../cloud/README.md) for the phase 2 approval boundary.
+
+## Tests
+
+See [AGENTS.md](../../AGENTS.md#tests-and-isolation) for test roots and fixture isolation. Run the boundary tests without Docker:
 
 ```sh
 bun test packages/loopy/_tests_/cloud-sandbox.test.ts
```

