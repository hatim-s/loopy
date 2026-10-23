---
title: Fable 5.1 review of the execution authority and read model proposal
status: review complete, implementation may proceed with the corrections below
date: 2026-10-23
reviewed: proposal.md, receipts-assessment.md, core-assessment.md, data-assessment.md at 6ffecdf
---

# Verdict

Approve the architecture with three blocking corrections and one scope cut. The receipt authority split, the shared activation planner, targeted node reads, the scope-item binding fix and definition summaries are the right shape and are grounded in the code. Two parts are not ready as written. The Durable Object admission path turns a lost loopback acknowledgement into a stuck run and then a non-retryable failure, which is worse than the filesystem path it replaces. The trigger-maintained run totals add an unverified workerd dependency, a schema migration and write amplification for a benefit nobody has measured. Cut the totals table this round and batch the count query instead.

I read the cited source rather than the assessments' summaries of it, and I checked each claim I rely on below. No tests were run and no file outside this one was touched.

# What this is, per the review rules

The proposal is one architecture but at least five separable changes. Land them as separate PRs in this order, each a single intent: scope-item binding fix (minor bug fix), shared activation planner plus `Store.getNodeRun` (major refactor), local child receipt owner (minor refactor), sandbox authority with filesystem and DO implementations plus routes and launcher selection (major feature), definition summaries plus `get(slug)` lookups (minor feature). The workload harness profile is tooling and goes with the feature it exercises. Do not fold the summaries change into the authority PR; they share nothing.

# Blockers

## B1. Lost admission acknowledgement on the DO path strands the attempt

Priority: highest. This is the one correction that changes a contract shape.

Mechanism. Today `Attempts.admit` writes the started receipt with a local fsync and launches the monitor in the same process (`apps/sandbox/src/attempts.ts:162-163`). A failure before the write leaves nothing behind and the host retries later. With the DO authority the same step becomes an HTTP call from the Bun bridge to wrangler to the receipt object. If the object commits and the response is lost or times out, the bridge throws, so `launch` never runs and nothing in the bridge monitors that id. The Workspace turn fails, retries in one second, looks up the id, sees `started`, writes `receipt: "started"` and polls forever at `pollMs` while heartbeating (`host/durable-work.ts:66-130`, `host/durable-wake.ts:35`). Nothing times it out. On the next bridge restart, recovery inspects Docker, finds no container and publishes `uncertain`, which the engine never retries. A transient loopback hiccup therefore costs a whole run. The proposal's own rule, "a lost admission response means read/recover, never another start", produces exactly this outcome, and the workload target of 461 expected successes depends on this not happening under load, where the existing 5 second provider timeout already shows tails above two seconds.

Smallest correction. Record the admitting session on the started record, and let the same bridge session launch once after an ambiguous response.

- Add `session: AuthoritySession` to the started `AttemptRecord`. Admission inserts it; it never changes.
- Keep the in-process `admissions` map as the only launch gate. On a thrown or timed-out `admit`, still inside that serialized admission, call `read(id)`. If the record is absent, rethrow (nothing committed, the host will retry). If it is `started` and `record.session` equals the bridge's current session and this process has not launched the id, call `backend.start` once and register the monitor. Any other case registers `backend.recover`.
- `backend.start` already fails closed on a duplicate name because `docker create --name` conflicts, so a second start in the same session is impossible even if the gate is wrong.
- After a bridge restart, `recoverable()` returns these records with an older session, and they take the recovery path exactly as proposed.

Required assertions, against the real local DO authority and the filesystem authority where it applies:

- Admit commits, response is dropped, same session: exactly one `backend.start`, one started record, the host observes started then finished, no `uncertain`.
- Admit commits, response is dropped, bridge restarts: zero `backend.start`, recovery runs, result is `uncertain`.
- Admit fails before commit: zero backend calls, zero records, the next host turn admits normally.
- Two concurrent admits for one id during an ambiguous response: one start, one record.
- Negative control: remove the session comparison and the restart case must launch, which the start-count assertion must catch.

## B2. Cut the trigger-maintained run totals; batch the count instead

Priority: high, because it removes a schema migration and an unverified runtime dependency from this round.

Mechanism. The totals table exists to replace one `GROUP BY status` query per definition in `listLoopies` (`service/service.ts:516-518`). The measured cost of that query was 0.012 ms on the 528-run snapshot, and the assessment states the measurements do not show these changes remove the HTTP tails. The design pays for that with three triggers whose bodies the schema splitter cannot install (`store/sqlite/schema.ts:71`, `query-schema.ts:70`), with trigger support in workerd that nobody has verified (the only trigger in the repo runs under Bun, `_tests_/store-durability.test.ts:99`), with two extra aggregate writes inside every claim, suspend, release and finish transaction, with a schema 16 migration across native 13/14/15 and portable 15 paths, and with rebuild rules. That is a lot of load-bearing machinery for an unmeasured gain.

Smallest correction. Replace the per-definition loop with one grouped read. Add `runCountsByDefinition(filter?)` to the store contract returning rows of `workspace, slug, status, count` from `SELECT workspace,slug,status,count(*) FROM runs GROUP BY workspace,slug,status`, implement it in SQL and memory, and let `listLoopies` map those rows by identity. That is one scan per request, no new table, no triggers, no version bump. Keep `runCounts` as it is for single-definition and time-bounded calls. Write down the trigger point for revisiting a persisted projection: when the grouped scan measured on the local workerd store exceeds a stated budget at a stated run count.

If the root still wants a persisted projection this round, maintain it in TypeScript at the five status-changing SQL sites (`insertRun`, `claim`, `suspend`, `finishRun` and the `finish` effect, `release` and `recoverRun`), each of which already reads the previous row, and prove equivalence against the grouped query after every store-contract operation. Do not use triggers in a runtime where DDL support is an assumption.

Consequence for acceptance. With B2 applied there is no shared schema change in this round. The "projection migration/rebuild equivalence" item in WORK.md reduces to proving that copied schema-15 stores open unchanged and that the cloud-only summary backfill is correct. Say that explicitly in the evidence rather than leaving a vacuous gate.

## B3. Export guard lifecycle has two transitions the contract does not define

Priority: high for the DO path, medium for filesystem.

Mechanism. The proposal fixes the real gaps: `readArtifact` drops its guard in `finally` even when helper removal failed (`apps/sandbox/src/attempts.ts:217-219`) and restart loses `artifactReads` entirely. But the contract as written cannot be implemented consistently. `endExport` "rejects a stale session", and "restart removes or reconciles that exact helper before releasing its retained guard". After a restart every retained guard carries the previous session, so the successor can never release them under the stated rule. Separately, when cleanup fails mid-request the proposal says keep the guard, but nothing states what the caller sees next or how the guard is ever cleared without a restart.

Smallest correction. Make the session check apply to the caller, not to the guard.

- `endExport({ session, token })` rejects when `session` is not the authority's current session. It releases a guard recorded under any earlier session. It is idempotent for a released token.
- A guard is released only after the owning bridge confirms the helper container is absent by name and label. If confirmation fails, keep the guard and return `conflict` to that and later export and same-volume admission requests until a later reconciliation pass clears it. Run that pass at startup and on the next export or admission attempt for that volume, not only at startup.
- `beginExport` records the exact helper name derived from the attempt id, so recovery never searches by prefix.

Required assertions:

- Export granted, bridge killed before cleanup, restart: the guard survives, same-volume admission returns `conflict` until the helper is confirmed absent, then one release under the new session succeeds and admission proceeds.
- Helper removal fails inside one request: the guard persists, the request fails, a later reconciliation with Docker healthy releases it, and no second guard for that volume is ever granted.
- `endExport` with a foreign token releases nothing. `endExport` under a non-current session is rejected.
- A different run volume admits normally while a guard is held.
- Negative control: restore the `finally` release and the restart case must admit while the helper still exists, which the guard-survival assertion catches.

# Verified non-issues

Record these so implementation does not add machinery for them.

Single bridge versus Docker fencing holds. The successor only starts once the predecessor's PID is dead (`apps/sandbox/src/receipts.ts:166-186`). Docker CLI children are spawned detached (`local/spawn.ts:85`), so an in-flight `docker create` can land after the successor inspects. That leaves a `created` container that is never started, because a dead predecessor cannot issue `start` for a create it never saw return. A delayed `start` can only exist for a container the successor already sees as `created`, and `rm --force` fences it (`apps/sandbox/src/docker.ts:227-241`). The remaining limits are a hung-but-alive predecessor, which the lock refuses to replace, and PID reuse, which blocks startup. Both reduce liveness, never safety. SQL session fencing protects journal writes only, as the proposal says. Keep the single-bridge assumption and the label checks; do not add name tombstones.

Local child terminal publication does not need hard links. The only writers are the child that won the exclusive `startReceipt` and a parent that has observed `ESRCH` for that child and reread the file (`executor/local.ts:41-70`). A dead process cannot race the rename. Keep rename. State the invariant in the module comment: terminal writes are serialized by process liveness, not by the file operation. Drop the hard-link option and the two-file reader.

Local slot retention keeps its deadlines. The engine re-emits `schedule_retry` for every pending sleep, wait timeout and retry on each traversal (`engine/invoke.ts:86-88`, `152-158`), and `ActivationWork.dispatch` arms a timer per effect. Hook signals arrive through the store subscription. So applying the durable retention rule locally changes only slot occupancy, up to the 60 second backoff cap (`engine/retry.ts:4`). Adopt the shared rule as proposed. Add the concurrency-one test from the core assessment and one more: during a held retry the heartbeat continues and a second claim fails.

# Nonblocking suggestions

Answer lookups from the bridge's monitor map. In durable mode every `provider.lookup` becomes Workspace to sandbox to wrangler to receipt object, and `activateDurable` issues up to sixteen per turn inside `Workspace.serial`. The bridge already knows every id it monitors; answer `started` from `active` and read the authority only for ids it does not own. Make "zero authority reads per lookup of a monitored id" a measured acceptance line, since turn length is the thing the workload tails are sensitive to.

Hash result bytes on the worker. The sandbox posts bytes, the worker computes the digest, derives the key and writes with conditional create. Never accept a client-supplied digest as the key. On collision, trust content addressing of the server-computed digest rather than reading back two megabytes.

Put the summary on the pointer row if workerd accepts `ALTER TABLE ADD COLUMN`. A nullable `summary_json` on `artifact_definitions` cannot mismatch its own generation and needs no join. The separate table is acceptable only if that DDL is unavailable, in which case match on `generation` alone; it is a fresh UUID per publication and already implies the revision.

Backfill lazily per slug. `summary(slug)` on a miss reads one graph and publishes under the pointer's generation. `listSummaries()` walks pointers and fills misses the same way, bounded by the existing 32 MiB listing budget. A bulk enumeration path adds nothing the per-slug path does not already do.

Keep `ExecutionReceipts` concrete. There is one implementation and host tests already inject fake executors. Ship `FilesystemReceipts` with `read`, `claim` and `finish`, reuse the shared execution-result schema instead of the second hand-written one in `executor/receipts.ts:12-24`, and extract an interface the day a second implementation exists.

Classify runtime failures with a closed list. The brief asked for it and the proposal only does it for the authority. The two catch sites that persist messages, `apps/cloud/src/scheduler.ts:223` and the daemon's `report`, should store a code from one `as const` list such as `ownership`, `provider_transport`, `provider_protocol`, `store`, `graph` beside the message, derived from typed error classes at the boundary. Tests then assert codes, not message substrings. Keep it to those sites; this is not a rewrite.

Filesystem authority and sessions. Do not implement fake epoch fencing on the filesystem adapter. Return a constant epoch under the OS lock and document that only the DO authority enforces session CAS.

Bounded model. Enumerate against the memory store and run a sampled subset of traces through SQL; exhaustive enumeration through SQLite will be slow enough that someone trims the depth. Print the shortest counterexample in the assertion message. Count explored states and transitions in the report so a later reader can tell a depth-four model from a depth-eight one.

Durable `getNodeRun` must return a detached copy from the memory store, matching `getNodeRuns`.

# Limits of what this round proves

A finite trace model proves its assertions over the enumerated states and depth only. It says nothing about arbitrary graphs, unbounded outages, or external side effects. The repeated workload establishes behaviour under that load and mix; it does not prove migration safety or isolate latency causes. R2 is a byte store with conditional create; it holds immutable results and artifacts and is never the authority for admission, sessions, export guards or run state. The DO SQL is that authority, and it is mutable and transactional. Exactly-once external effects remain impossible without cooperation from the external system; controlled retries may repeat them, and that is documented behaviour, not a defect. Docker has no demonstrated provider-enforced lifetime while every monitor is down. The traversal rewrite, payload preview columns and time rollups stay deferred as the root intends; nothing here depends on them.

# Decisions settled for the implementer

- Two receipt contracts, not one. Local child receipts stay a concrete filesystem class. The sandbox authority has filesystem and DO implementations behind one interface with explicit startup selection and no fallback.
- Started records carry the admitting session. Same-session relaunch after an ambiguous admit is allowed once; cross-session is recovery only.
- Export guards persist until confirmed helper absence, release under the current session regardless of the recording session, and surface `conflict` while held.
- Both hosts retain lease and slot on retry and rate denial. One planner computes effects, work and disposition; each driver keeps its own lifecycle around it.
- `acquireDispatch` takes a receipt lookup function, not an `Executor`. The fake executor is deleted.
- `Store.getNodeRun(key)` serves started-only polls; completions and denials reload full state.
- No shared schema version change this round. Counts come from one grouped query. Summaries are cloud-only tables or columns in the Workspace object with generation-checked backfill.
- Scope items bind one JSON array. Any future batch lookup does the same.
- Results publish bytes before the SQL pointer, hashed server-side, keyed under workspace.
- Fresh durable selection refuses a populated filesystem receipt root. No importer this round.

# Inspection record

Read in full: the four notes, `apps/sandbox/src/{attempts,admission,receipts,docker,artifacts,server,config,result,process,docker-client}.ts`, `apps/cloud/src/{workspace,worker,provider,artifacts,artifacts-storage,environment,http,scheduler,sql-driver}.ts`, `packages/loopy/src/host/{activate,durable,durable-work,durable-wake,rate-limit,activation-work}.ts`, `engine/{step,invoke,retry,node-run}.ts`, `executor/{receipts,local,execution,worker}.ts`, `core/store.ts`, `store/sqlite/{schema,local-schema,query-schema,store-schema,driver,bun-driver,store,runs,nodes,waits,events,query-nodes,query-runs,store-rows}.ts`, `store/portable.ts`, `service/registry.ts` and the cited regions of `service/service.ts`, `local/daemon.ts`, `host/daemon.ts`, `local/spawn.ts`. Tests read: the cited regions of `engine-control-unwind`, `host-lifecycle`, `cloud-durable-host`, `cloud-worker`, `cloud-sql-driver`, `store-durability`, `executor` and the test list of `cloud-sandbox`. Grep confirmed one remaining generated placeholder list at `query-nodes.ts:122` and no `DELETE FROM runs`. Git state: branch `cloud-integration`, HEAD `6ffecdf`, with the pre-existing `.notes/cloud/tasks.json` modification and the untracked architecture directory that this task did not create. This file is the only artifact written.
