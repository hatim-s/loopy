# Core, activation and scheduling assessment

Assessed source: branch `cloud-integration`, commit `6ffecdfd60e16aaa335467684d918b3cd8b44813`. This is the core research assessment for root Astra's architecture round. It is ready for Fable 5.1 review before implementation. No implementation, tests, workload, service, Docker, cloud, API, personal state, commit or merge operations were performed for this assessment. Remote deployment remains unapproved.

## Recommendation

Keep the existing reducer and durable store transactions. Make activation policy smaller and shared, then remove full node materialization from receipt-only polling. Do not replace the lexical engine, unify the two scheduler loops, or introduce a plugin framework this round.

The useful core already exists. `engine/step.ts` takes explicit time and events, resolves graph semantics, fences completions by execution key and attempt, and returns typed effects. `Store.apply` commits durable changes under an owner token. Local and durable execution already enter through injected contracts. The weakness is that activation and scheduler adapters also own pieces of lifecycle policy. Those pieces have drifted.

Prioritize a shared host activation plan and admission decision, with bounded trace tests. A targeted node-read contract is the next, concrete performance change. Keep full reloads before reducing completion events. Static graph indexing is a later optimization unless measurements show traversal dominates.

## Architectural sources of the four fixed bugs

These fixes are present in the assessed source. The cited tests were read, not executed in this assessment.

### Suspension lost its recovery owner

Suspension and ownership release are separate operations. `engine/step.ts:115-141` emits `suspend_run`; `host/durable.ts:136-145` commits it; `host/durable.ts:190-193` later releases ownership. A crash or failed release leaves the legitimate intermediate state `suspended + owner`. A selector that assumes all suspended runs are unowned makes its own recovery path unreachable.

The current cloud scheduler explicitly selects owned suspensions in `apps/cloud/src/scheduler.ts:72-101`, respects fresh foreign leases, retries failed releases, and does this outside execution-slot admission. Its next-alarm query also includes these rows. This is a lifecycle recovery invariant, not a traversal bug. Local SQL already includes owned running and suspended rows in `store/sqlite/store-rows.ts:73-75`, followed by the owner's stale check in `store/sqlite/runs.ts`.

Keep the fixed recovery path this round. Making suspension and release atomic would also change direct `Store.suspend`, effect transactions, event ordering and host cleanup. It is a larger change than extracting shared activation policy. Do not delete recovery merely because the happy path releases promptly.

Existing oracles: `cloud-scheduler.test.ts:252-322` covers same-token, expired foreign and fresh foreign owners across due sleep, future sleep and indefinite wait. Lines 352-409 cover repeated release failure and recovery with all execution slots occupied. Expected outcomes include one original effect, preserved wait identity, no premature foreign release, the correct lease/deadline alarm, and no alarm for a released indefinite wait.

### One invalid schedule blocked workspace progress

The original architectural failure was using workspace-level exception handling for a schedule-local failure. The same overdue bad row could also dominate every bounded schedule batch. Durable firing is already atomic and versioned in `store/sqlite/schedules.ts:119-148`; run progress should not depend on every sibling schedule being valid.

`apps/cloud/src/scheduler-schedules.ts:47-102` now isolates each schedule, disables input that no longer matches the current graph, and persists a version-associated retry deadline for other failures. The query excludes deferred failures so later schedules can enter its batch of 32. `WorkspaceScheduler.tick` continues to release suspensions and reconcile runs after schedule processing.

Keep this policy in the cloud schedule owner. Local `host/schedules.ts` has different startup catch-up behavior and minute fire keys; cloud coalesces missed ticks using its pinned scheduled timestamp. Sharing their whole loop would silently change behavior. Preserve the shared transactional `Store.fireSchedule` contract instead.

Existing oracles: `cloud-scheduler.test.ts:412-461` checks invalid input, registry outage, healthy schedule, queued run and running completion together. Lines 463-487 check failures before and after fire commit with exactly one scheduled run. Lines 490-513 check that 32 failures yield to a later healthy schedule. These test failure isolation, persisted backoff and fire deduplication, not universal scheduler fairness.

### Unknown transport state was finalized too early

The architectural error was collapsing inability to observe a worker into a terminal execution result. A request failure says nothing reliable about whether the worker is still performing external effects. Releasing its slot or retrying it at that point can overlap work.

The current `apps/sandbox/src/attempts.ts:222-244` leaves a receipt started on backend exceptions and switches to recovery of the pinned container. `apps/sandbox/src/docker.ts:200-217` propagates non-timeout wait failures, confirms termination after a timeout, and `recover` rejects an apparently stopped wait when inspection still reports running. `apps/cloud/src/provider.ts` throws on failed transport rather than inventing a missing receipt. `host/durable-work.ts` does not convert those exceptions into reducer failure events.

Keep this division. The provider owns authoritative receipt observations and worker lifecycle. The host owns when an observation can become a graph event. A confirmed missing worker after a started receipt yields a non-retryable `uncertain` result. An unobservable worker stays unresolved and consumes its running slot.

Existing oracle: `cloud-sandbox.test.ts:406-504` simulates lost start acknowledgement and failed wait/inspection transport. It checks a persisted started receipt through restart, one start, one eventual owned kill after recovery, and a terminal receipt only after termination. `cloud-durable-host.test.ts:135-165` covers lost provider responses and disappearance of a previously started receipt. No real Docker or network behavior is established by reading these tests.

The stopped-worker log-read catch in `docker.ts:260-275` still turns failure to retrieve a valid result into `uncertain`. That can lose a successful result, but it cannot justify automatic re-execution. Distinguish that conservative terminal uncertainty from claiming a possibly live worker has stopped.

### Newly queued work missed the daemon wake

The missing invariant was that a committed mutation creating due work must invalidate the scheduler's idle wait. Depending on each caller to remember an explicit wake leaves another mutation entry point able to omit it.

`host/daemon.ts:77-89` now subscribes to committed queued-run creation, explicit run wake and schedule save events. SQL publishes its outbox notifications after the transaction returns in `store/sqlite/events.ts`. `Daemon.wait` uses the wake latch and abortable wait. The event is a prompt to re-query authoritative due work, not an instruction to execute a supplied row.

Keep subscription policy in the daemon and durable alarm installation in the cloud adapter. The in-process subscription alone does not prove notification across independent store instances or a process crash. Local capped polling supplies a fallback; durable reconstruction relies on persisted work and alarms.

Existing oracles: `daemon.test.ts:228-263` tests committed queued creation against memory and SQLite stores, interrupted idle sleep and completion without explicit wake. Lines 265-299 cover save/enable and one schedule fire without a busy loop. Lines 301-320 reject unrelated wake triggers. `daemon-concurrency.test.ts` checks that a held activation does not stop later work and overdue schedules.

## A smaller core with fixed adapter contracts

Keep graph semantics in `engine`, activation lifecycle policy in `host`, and durable mutation invariants in `store`. Here, a smaller core means fewer independent owners of those decisions. It does not mean moving SQL, alarms or process management into `core/`.

The contracts should remain closed and specific:

- The reducer accepts `Graph`, `EngineState` and `EngineEvent`, and returns `Transition`. It owns graph execution transitions for completion, retry, rate denial, wait registration, cleanup and outcomes. Preserve the store's existing validated wait-resolution operation, which atomically updates the hook, waiting node and wake deadline.
- A shared host planner partitions a transition into ordered store effects and executable work, and derives a disposition such as active, suspended or finished. It owns the rule that retries and rate-limited attempts retain the run lease and concurrency slot.
- The store implements owner fencing, atomic effect batches, atomic signal/node/wake changes, rollback, schedule fire version checks and commit notifications. The planner must not replay already-committed batches blindly. Owner fencing is not general batch idempotency; log insertion allocates a new index on each accepted write.
- `Executor` remains the local awaitable adapter. `DurableExecutionProvider` remains prompt start plus lookup. Both report the existing receipt/result unions. Transport failure remains an exception with no fabricated receipt. Time, entropy, retry waits, OS lifecycle and alarm persistence stay in their existing adapters.

An adapter may return observations or perform a committed command. It may not mutate `EngineState`, inject arbitrary node writes, alter traversal order, or supply callbacks that edit reducer internals. No registry of plugins, arbitrary middleware or adapter-selected retry policy is needed.

The host interfaces need only the methods they call. For example, admission uses receipt lookup and rate-limit acquisition, not `Executor.execute`. `host/durable-work.ts:84-90` currently constructs a fake executor whose execute method throws solely to call `acquireDispatch`. That is direct evidence that admission and effect execution need separate typed inputs.

## Implementable scope for this round

### 1. Share activation disposition and admission policy

Own this change in `packages/loopy/src/host/`. Add one internal `activation-plan.ts` used by `activate.ts` and `durable.ts`. Accept a `Transition`, preserve effect order, retain store effects except an ineligible suspension, and return executable work plus an explicit disposition. Keep the actual `store.apply` and commit-before-dispatch sequencing visible in each driver. Move the durable retry/slot rule from `durable.ts:130-144` into this planner and delete the duplicated effect partitioning. Reuse one result-to-event formatter between `activation-work.ts` and `durable-work.ts` when doing this extraction.

There is a behavior difference to resolve deliberately. `engine/step.ts` can suspend a parallel wait plus retry. `engine-control-unwind.test.ts:146-179` explicitly tests that reducer output. Durable activation suppresses the suspension; local `activate.ts:51-63` currently commits it and releases the slot. Recommend retaining the existing reducer output and having both hosts apply the durable retention policy. This changes local host behavior for a retry or rate denial beside a wait/sleep. It matches the documented host rule, but is not a behavior-neutral extraction. Fable should review this choice before implementation.

Extract the admission decision from `host/rate-limit.ts` so it returns admission or a typed `rate_limited` event for one dispatch. Use a receipt reader and the existing store limit contract. The local admission loop still applies reducer events and tracks checked in-flight identities. Durable reconciliation returns the denial event to its existing fresh-state commit path. Delete its fake executor and direct synthetic-transition apply path. A rate denial retains the same attempt, never starts the provider, and keeps its retry deadline.

Keep driver differences explicit. Local activation waits and drains work, then releases on exit. Durable activation budgets work, retains a cursor and lease across turns, installs bounded wakes and retains ownership on reconciliation failure. `host-lifecycle.test.ts` requires local release on persistence/read failure; durable tests require retention. Do not flatten these policies into a boolean-heavy universal driver.

Oracles: preserve the current host, durable-host, wait-race and engine-control tests. Add the local parallel retry/wait case to `host.test.ts` or `wait-host.test.ts`, with a held retry and a second queued run at concurrency one. Assert the first run remains owned/running, the second does not start before the retry settles or true suspension, and hook signaling still progresses. Exercise the same bounded event sequences through both hosts and compare durable node state, attempt numbers, logs and outcome. Ignore adapter-specific token, polling and cursor representation only.

### 2. Remove full node reads from receipt-only polling

First remove one narrower redundant write. `durable-work.ts:126-130` writes `receipt: "started"` even when the matching node already records started. Skip that receipt-metadata write when the observation adds no information. This avoids the extra node/attempt/scope writes and running event from that path. It does not remove the initial `run_started` reconstruction writes. The behavior change is fewer duplicate running notifications, with unchanged durable values.

The next useful performance change follows admission extraction. Add `Store.getNodeRun(key: ExecutionKey): Promise<NodeRun | undefined>` in `core/store.ts`, implement it using the existing SQL `readNode` and memory map in `store/sqlite/nodes.ts` and `store/memory-nodes.ts`, and consume it in `host/durable-work.ts`. The complete key already includes run and ordered scopes. Return the same detached, boundary-parsed record semantics as other reads. No schema or data migration is needed.

Today each durable turn reloads every node for its initial reducer call. It then reloads all nodes for each selected work item at `durable.ts:174`, reloads again for each returned completion at line 127, and reloads at line 197 for wake planning. A turn polling B started attempts with N saved nodes materializes roughly B times N records before any completion. Each SQL read parses every record; each memory read clones them. `maxWork` bounds provider/sample operations, not the cost of full graph reconstruction or traversal.

After step 1, a receipt poll needs the current target node to check status, attempt and receipt history, not all node outputs. Replace that poll read with the targeted method. A denial or completion must still enter `commit(event)`, reload the full state and let `step` reject a stale attempt. Retain the final full read used by wake calculation. Remove the redundant local startup read at `activate.ts:35` only by arranging one authoritative reload before the first reduction, not by keeping an earlier stale snapshot.

For a stable turn with B polls returning started and no completion or denial, target two full node reads, one for initial planning and one for final wake planning, plus B targeted reads. Do not claim a wall-clock gain from this source estimate. It removes B full materializations while leaving the engine's deep clone and traversal costs intact.

Keep these assumptions explicit. Cloud serializes turns and hook mutations, as required by `activateDurable`'s contract. The current direct receipt-started write at `durable-work.ts:126-130` is owner-fenced but not conditional on the stored node attempt. Under concurrent same-token node mutation it could overwrite a newer node. The existing old-completion test covers finished receipts, not that write. Preserve serialization and add a targeted test of this assumption if the refactor permits a new interleaving. A targeted read is not a compare-and-set and does not strengthen that guarantee. Do not broaden to arbitrary concurrent writers in this round.

Oracles: extend `cloud-durable-host.test.ts` with many persisted nodes, more started attempts than `maxWork`, and a counting store wrapper. Assert fixed full-read count for started-only polling, bounded targeted reads, unchanged cursor fairness, no immediate-alarm loop, no extra starts and correct heartbeat bound. Check that the first newly observed started receipt persists, while an already-started poll adds no receipt-metadata event or attempt change. Keep its stale in-flight completion test at lines 192-224 and `wait-race.test.ts` passing. Test targeted reads against memory and SQL for missing keys, nested scope identity and detached returned values. These are durable/read boundary tests, not a new broad suite of helper tests.

### 3. Add bounded state exploration for the changed invariants

Use a dedicated test under `packages/loopy/_tests_`, with a small independent reference model. Reuse the existing injected stores, clock and provider boundaries. Do not add fault-injection hooks or a production testing API. Include this in the implementation gate, rather than postponing it until after the workload.

Start with one run, two execution nodes, one wait, two owner tokens, attempts 1 and 2, concurrency one, and work budgets one and two. Model a second queued run only for the slot-retention check. Use representative times immediately before, exactly at and immediately after retry, wait and lease boundaries. Scope isolation can use two map items with distinct ordered scope keys; arbitrary nested graph generation is outside this first model.

Enumerate finite traces up to a declared depth, for example eight externally observable actions, and report reachable states and transitions actually explored. Generate only enabled actions and deduplicate equivalent states using a canonical representation that includes all future-relevant durable and scheduler state. Keep a shortest counterexample trace. Actions should include start admission, admission response loss, started/finished lookup, lookup failure, completion duplication, stale completion, signal, time advance, reconstruction and suspension release failure. Treat before-commit failure and committed-response loss as different actions. Persisted store effects survive reconstruction; volatile queue and cursor handling must follow the chosen adapter contract.

Check these oracles after each action:

- A provider start observes a persisted running node with the matching key and attempt. Repeating a request for an admitted identity does not launch a second worker in the modeled provider.
- Transport failure cannot become a graph completion or authorize another attempt. A confirmed missing started receipt becomes uncertain and the engine does not retry it.
- Stale and duplicate completion events cannot change a newer attempt, append logs again or change terminal output.
- Retry and rate denial preserve ownership and slot occupancy; denial preserves the attempt. A waiting sibling cannot release that slot.
- An accepted signal resolves one wait and preserves an immediate wake even if an older suspension batch subsequently commits. Signal acceptance at the timeout boundary follows the existing deadline-wins rule.
- Interrupted suspension remains recoverable without replaying completed work; fresh foreign ownership survives until expiry. Terminal/indefinite released runs do not create repeated immediate wakes.

Use the reference model to predict accepted events and durable state, then run each trace through the real reducer/host/store adapter. Merely replaying reducer output into a fake store and asserting the fake's own counters is not an independent oracle. Run the relevant durable boundary traces against both memory and SQL. Keep the scheduler-specific invalid-batch and wake tests, since a reducer model cannot establish them.

Every explored safety assertion is universal only over the enumerated model and finite bounds. Random property tests can search larger graphs and reorderings, but passing samples do not establish exhaustive coverage. A finite-state model checker exploring the complete reachable graph could prove an invariant for that finite abstraction, with an adequate abstraction/refinement argument. A depth-limited trace suite does not prove arbitrary-length executions. Neither is a formal proof of the whole system.

Progress checks need a stated fault bound and fairness assumptions. For instance, after transport and storage recover, recurring alarms eventually run, the provider eventually reports terminal state, and a finite admitted graph can settle. Safety alone does not prove eventual completion; unbounded outages and infinitely occupied slots defeat that claim. Retain the existing wide-work cursor tests and 32-schedule batch test for their concrete progress bounds.

## Traversal costs and why to defer an engine rewrite

There are real repeated scans. `step.ts:149` deep-clones the whole state before checking most events and line 176 restarts traversal at graph entry. `traversal.ts:30-61` repeatedly finds graph nodes, scans edges in order and walks ancestors to select lexical continuation. `evaluate`, `resolve.reference` and `node-run.write` repeatedly scan node runs; `sameExecution` serializes both keys for comparison. `control.ts:27-39` searches node runs for each map item and traverses started/completed items again while constructing outputs. Durable turns also sort the remaining queue for every work selection.

The mechanism predicts scaling pressure, not the measured bottleneck. No profiler or benchmark was run here. Replacing this with an incremental ready queue would require durable lexical continuations, nested map progress, scope-aware references and failure/cleanup unwinding to agree after reconstruction. Current tests encode substantial semantics: selected branch/switch arms, ordered nested scopes, map concurrency and collection order, out-of-order parallel completion, cleanup after started branches settle, rescue diagnostics, entropy replay and sleep alongside running work. Preserve that implementation this round.

If step 2's later measurements show traversal still dominates, the next bounded change is a per-reduction node-id index plus lazily memoized lexical continuation inside `engine/traversal.ts`, created by `step.ts`. Preserve the exact first matching edge rule, scope ancestry and effect order; do not reinterpret edges as a topological execution order. Keep the lookup data ephemeral and outside serialized `EngineState`. An execution-key index is a separate change because every `write` must update it and ancestor reference lookup must retain ordered scope fallback.

Avoid a process-global graph cache until revision immutability and cache bounds are explicit. Avoid pruning completed node outputs, changing `structuredClone` to shared mutable values, or retaining full node state across provider awaits. Those changes need a stronger snapshot/mutation contract. They are not prerequisites for the targeted-read improvement.

## Limits on effects and proof

Exactly-once effects are impossible in general external systems. A worker can send an accepted external request and crash before writing a finished receipt. The host cannot infer whether that external effect occurred from a timeout or missing acknowledgement. A retry can duplicate it; refusing retry can leave the workflow unresolved or uncertain.

This design can enforce durable identity, deduplicated admission per execution key and attempt, commit-before-dispatch, fenced host writes, reconciliation of finished receipts and no automatic retry of uncertain results. Controlled retries intentionally create another attempt and may repeat an external effect. End-to-end deduplication requires cooperation from the external system, such as an idempotency key or a shared transaction, with its own retention and failure assumptions.

The tests and model assume atomic SQL transactions, durable receipt writes, correct provider identity/content deduplication, bounded provider requests, serialized durable turns/mutations, valid graph input, appropriate clock/lease behavior, and correct wake delivery or recovery. They cannot prove Docker termination, filesystem durability under all crashes, external API semantics, Cloudflare alarm guarantees, actual resource isolation, production concurrency or provider honesty. Adapter contract tests and later real workloads supply evidence for narrower parts of that chain.

## Review and implementation handoff

Fable 5.1 should review this assessment and the other round assessments before implementation. The concrete choices to settle are the shared host retention policy, admission returning reducer events, and the targeted-read contract with full completion reloads. This assessment does not perform or stand in for that review.

Implementation should remove the superseded planner partitions, result-event mapping and fake executor in the same change. Keep existing tests unless an expectation changes for the explicit local retry/slot policy. Report added and deleted lines, changed behavior, any moved/deleted tests and remaining assumptions. Keep the architectural layer test and browser-safe core/engine/contract builds intact. No package split or public plugin API is justified.

The parent should run focused engine/host/store/scheduler tests, then the required `bun run check`. Later, under the parent's workload authorization, repeat the same 525 cloud and 45 daemon workload definitions with separate fresh evidence, unchanged counting rules and workload parameters. Compare outcomes, attempts, receipts, ownership, schedule fires, wake behavior and performance measurements. Preserve baseline receipts separately. Passing source tests does not substitute for these workload results. Merge/main actions remain parent-owned; this assessment authorizes none of them and leaves remote deployment unapproved.

## Inspection record

`git branch --show-current` printed `cloud-integration`. `git rev-parse HEAD` printed `6ffecdfd60e16aaa335467684d918b3cd8b44813`. Initial `git status --short` printed no changes. Source inspection used `rg --files`, `rg -n`, `cat`, `sed -n` and `nl -ba` on the guidance, modules and tests cited above. No test or build command ran. The only authored file is this assessment note. Recommendations are source-derived and have no new runtime or workload validation.
