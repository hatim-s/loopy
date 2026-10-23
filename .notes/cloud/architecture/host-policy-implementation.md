---
title: Shared host activation policy implementation
status: focused verification complete
date: 2026-10-23
base: 6ffecdfd60e16aaa335467684d918b3cd8b44813
---

# Result and ownership

Implemented the host-policy lane in cloud-integration at the requested base. The accepted proposal and Fable round-1 corrections govern this change. No commit, push, main integration, cloud execution, workload, shared-service operation or child task was performed. No index.ts was edited. Existing .loopy datasets were not opened or changed by this lane. All new SQL tests create and remove private temporary directories.

# Contracts and export needs

The public addition, implemented by MemoryNodes and SqliteNodes, is:

```ts
getNodeRun(key: ExecutionKey): Promise<NodeRun | undefined>;
```

Memory returns a structuredClone of the matching record. SQL calls existing readNode(key.runId, executionKeyString(key)), which parses nodeRunSchema. Missing keys return undefined. The complete key preserves ordered scopes. Existing Store and store class exports expose the addition. Root has no new export work for this lane. Any separate Store implementations or structural test doubles must implement this method; this lane did not edit other owners' test types.

activate, ActivationOptions, ActivationResult, activateDurable, DurableActivationOptions, DurableActivationResult and DurableExecutionProvider retain their public signatures. No wire schema, shared schema version, trigger, totals table, traversal algorithm or cache was added.

The internal source-module signatures are:

```ts
type ActivationWorkEffect = Extract<
  Effect, { kind: "dispatch" | "sample" | "schedule_retry" }
>;

planActivation(transition: ReturnType<typeof step>): {
  storeEffects: StoreEffect[];
  work: ActivationWorkEffect[];
  disposition:
    | { kind: "active" }
    | { kind: "suspended" }
    | { kind: "finished"; outcome: RunOutcome };
};

acquireDispatch(options: {
  graph: Graph;
  store: Store;
  lookup: Executor["lookup"];
  at: string;
  dispatch: Extract<Effect, { kind: "dispatch" }>;
}): Promise<Extract<EngineEvent, { kind: "rate_limited" }> | undefined>;

completionEvent(
  dispatch: Extract<Effect, { kind: "dispatch" }>,
  result: ExecutionResult,
  at: string,
): EngineEvent;

reconcileDurableWork(options: {
  store: Store;
  graph: Graph;
  runId: string;
  token: string;
  provider: DurableExecutionProvider;
  work: DurableWork;
  at: string;
}): Promise<EngineEvent | undefined>;
```

These declarations document the inferred planner return and existing internal module exports. They do not request package entry exports. Executor["lookup"] is exactly (key: ExecutionKey, attempt: number) => Promise<Receipt>. reconcileDurableWork no longer accepts a full EngineState. ActivationWork.dispatch accepts ActivationWorkEffect[] and its unused inFlight getter is deleted.

# Changed semantics

- The planner preserves each partition's original effect order. schedule_retry belongs to both store effects and local timer work. Both drivers use the planner's disposition; durable still rereads the run before its final lifecycle decision.
- Retry and rate-limited nodes suppress suspend_run in both drivers, including beside waits or sleeps. This corrects local slot release. Actual suspension still releases local work and durable ownership.
- Local commits the reducer transition before receipt/rate admission and execution. Rate denials return as events through its full-state reload loop. The old admission loop and durable fake executor are deleted. In-flight deduplication remains in ActivationWork.start.
- Local quota acquisition moves after the initial durable batch and uses observation time. A failed initial store write therefore consumes no local quota. Parallel admissions now await their own receipt reads; quota winners need not follow effect order when those reads settle in a different order. The ordered effect lists themselves are unchanged.
- Durable denials also return an event to commit, which reloads all current nodes. They cannot overwrite a newer attempt from the old pre-provider snapshot. Completion reduction keeps the same fresh-read fence. No mutable graph state is cached across provider awaits.
- Started-only durable polls load the matching node instead of every node. Already-started records skip the extra receipt metadata batch. Initial run_started reconstruction still writes running nodes; this is not a zero-write turn.
- A stable turn polling B started attempts performs two full node reads and B targeted reads. The nine-attempt test with B=3 observes 2 full reads, 3 targeted reads and one reconstruction batch on each of three turns. Its cursor covers all nine identities, retains one start per identity and schedules the next poll at the heartbeat bound.
- Local startup removes one redundant full read. It still reloads before its first and every subsequent reduction.
- Local continues to wait, drain and release on failure. Durable keeps leases, cursors and bounded wake scheduling across uncertain reconciliation. Transport errors remain errors; a confirmed missing started receipt becomes uncertain and does not create another attempt.

# Focused verification

Final focused run: 69 pass, zero fail, 13 test files, 655057 assertions, 3.49 seconds. No existing tests were deleted or moved. The selected files cover existing lifecycle failures, durable recovery, stale completion/log fencing, wait signals and timeout boundaries, daemon concurrency, layer imports, plus the new lane invariants.

```sh
bun test packages/loopy/_tests_/host.test.ts packages/loopy/_tests_/host-lifecycle.test.ts packages/loopy/_tests_/host-slot-retention.test.ts packages/loopy/_tests_/host-targeted-polls.test.ts packages/loopy/_tests_/host-admission-race.test.ts packages/loopy/_tests_/host-denial-fence.test.ts packages/loopy/_tests_/host-policy-model.test.ts packages/loopy/_tests_/wait-host.test.ts packages/loopy/_tests_/wait-race.test.ts packages/loopy/_tests_/cloud-durable-host.test.ts packages/loopy/_tests_/engine-control-unwind.test.ts packages/loopy/_tests_/architecture.test.ts packages/loopy/_tests_/daemon-concurrency.test.ts
bunx tsc --noEmit -p packages/loopy/tsconfig.portable.json
bunx tsc --noEmit -p /tmp/loopy-host-focused-tsconfig.json
bunx eslint packages/loopy/src/host/{activation-plan,completion-event,activate,activation-work,durable,durable-work,rate-limit}.ts packages/loopy/src/core/store.ts packages/loopy/src/store/{memory-nodes,sqlite/nodes}.ts packages/loopy/_tests_/host-{policy-fixture,policy-model,policy-replay,policy-model.test,targeted-polls.test,slot-retention.test,admission-race.test,denial-fence.test}.ts
bunx biome check packages/loopy/src/host/{activation-plan,completion-event,activate,activation-work,durable,durable-work,rate-limit}.ts packages/loopy/src/core/store.ts packages/loopy/src/store/{memory-nodes,sqlite/nodes}.ts packages/loopy/_tests_/host-{policy-fixture,policy-model,policy-replay,policy-model.test,targeted-polls.test,slot-retention.test,admission-race.test,denial-fence.test}.ts
git diff --check -- packages/loopy/src/host packages/loopy/src/core/store.ts packages/loopy/src/store/memory-nodes.ts packages/loopy/src/store/sqlite/nodes.ts
```

Both typechecks and ESLint exited zero with no output. Biome printed "Checked 18 files in 5ms. No fixes applied." The temporary focused TypeScript config extends the absolute repository tsconfig.json, sets typeRoots to the repository node_modules, includes absolute paths matching _tests_/host-*.ts plus host.test.ts, cloud-durable-host.test.ts and wait-host.test.ts, and sets exclude to an empty array. Its imports are checked transitively. Full bun run check was deliberately not run under this lane's scope.

An intermediate wait-host run failed three service-facing tests while another lane added registry.summary. Those same tests pass in the final run. No service or registry files were repaired by this lane. Early model work corrected its independent oracle to respect the existing parallel rule: a failed execution waits for its already-started approval sibling before the run fails. This was an oracle correction, not a reducer change.

# Bounded model and negative controls

The independent model imports no production transition helpers. Its oracle models one execution plus an indefinite wait, attempts 1 and 2, owners 1 and 2, lease 3000 ms, finite before/at/after retry and lease boundaries, and turn budgets 1 and 2. Actions include turn, lost lookup, committed start response loss, interrupted release, success, retryable failure, disappeared started receipt, signal, time advance and reconstruction. It compares durable node/run/owner/heartbeat/hook state, attempts, starts and logs after every action. Every actual start also checks the persisted running key and attempt first.

Breadth-first enumeration deduplicates the complete model state and retains shortest traces. For each budget it explored depth 8, 1652 states and 4687 outgoing transitions through real activateDurable, reducer and MemoryStore. Combined this is 9374 checked model edges, with 1652 states per budget. No counterexample remains. Five representative traces also run through SqlRunStore and Bun SQLite with fresh schema-15 temporary databases and a lease-only owner policy. These are SQL contract samples, not exhaustive SQL enumeration or workerd evidence.

The wider nine-execution cursor case, local concurrency-one retry/rate-limit plus second queued run, local sleep retention, finite wait races and stale completion tests are separate directed checks. They are not included in the model state count.

Each source mutation below was applied individually, tested, restored byte-for-byte and rejected. The temporary runner and full outputs are /tmp/loopy-host-negative-controls.py and /tmp/loopy-host-negative-controls.json.

| Removed boundary | Selected test observation |
| --- | --- |
| Retry slot retention | concurrency-one test sees activation exit before arming retry |
| Targeted read | started-only full reads increase from 2 to 5 |
| Skip duplicate receipt write | started-only apply batches increase from 1 to 4 |
| Local fresh event reloads | accepted approval ends in suspension instead of success |
| Missing-started uncertainty | run remains pending and starts again instead of failing uncertain |
| Detached memory result | mutation changes the stored scope order and output |
| Commit error propagation before dispatch | write failure loses its primary error and work executes without its batch |
| Durable fresh denial reload | stale snapshot overwrites attempt 2 with rate-limited attempt 1 |

Running the bounded model with retry retention disabled independently reports the shortest counterexample at depth 3, "turn -> retry -> turn", for both budgets. The run is suspended where the oracle requires running. All mutation edits were restored before the final green run.

# Limits and root handoff

Finite enumeration covers the stated small model, not arbitrary graphs, nested maps, provider outages or external side effects. Rate-limit and sleep behavior are directed tests, not model actions. Budgets 1 and 2 have the same model state count because this model has one executable identity; wide cursor fairness is checked separately. The stale-event tests exercise reducer fences and do not grant permission for arbitrary same-token concurrent mutations.

The receipt-started write still relies on the documented serialized durable driver. getNodeRun is a read, not compare-and-set. Local release and durable retention remain intentionally different. Reducer cloning/traversal remains unchanged and can dominate wide graphs. The read-count result makes no wall-clock or HTTP latency claim.

Root still owns the full integration gate, live workload, real workerd/provider exercises, final independent review and eventual main integration. This lane proves no Docker, cloud admission authority, R2, deployment, production data or copied historical database behavior. No broad fullcheck was run. No additional export is required.

# Scoped content receipt

Starting and current HEAD: `6ffecdfd60e16aaa335467684d918b3cd8b44813`. Source: +175/-198 lines. New tests and fixtures: +1123/-0 lines. Total code/test scope: +1298/-198 lines across 18 files. Counts compare tracked files to HEAD and count untracked files as additions. Other lanes are excluded. No casts or any types were added; tests use as const for literal unions.

Aggregate SHA-256: `98409beae9cade286d5a1cb3d2a0eb7b303d259d97ade07130cb548b377f6d11`. It hashes sorted manifest rows of relative path, NUL, file SHA-256, newline. This documentation file is excluded to avoid a self-referential digest.

| File | Added | Deleted | SHA-256 |
| --- | ---: | ---: | --- |
| `packages/loopy/_tests_/host-admission-race.test.ts` | 87 | 0 | `e62d37f13178f3f71acc62c1dc13aff23226df2371a9721cf78b4e91952a0da0` |
| `packages/loopy/_tests_/host-denial-fence.test.ts` | 42 | 0 | `ff43e4c62a674d92a3c1cfb696886c9fe502403397c4bcf367fee7217ac09240` |
| `packages/loopy/_tests_/host-policy-fixture.ts` | 68 | 0 | `b544b289439ec1723f3f8452476ff7c716cf5c37901b4e82dde6e31876f2be61` |
| `packages/loopy/_tests_/host-policy-model.test.ts` | 76 | 0 | `3c1f4482bef770261908139a2c87be5ed7c48f1d38deed5f38f39c1867ddc9ec` |
| `packages/loopy/_tests_/host-policy-model.ts` | 217 | 0 | `039bcee19ba2bf759dd12a5ec2803c2d9479b751cd4654d3322c3be10c010f17` |
| `packages/loopy/_tests_/host-policy-replay.ts` | 191 | 0 | `431ce71227044e5db7e87e3041ba7757e49f279fdd67e5d5cfeef1010b1eb41e` |
| `packages/loopy/_tests_/host-slot-retention.test.ts` | 205 | 0 | `87eeb8db99c3b29aea7d906b3ca225c6b2a2450338c9a9444c0f2380ef356aa3` |
| `packages/loopy/_tests_/host-targeted-polls.test.ts` | 237 | 0 | `1fc4d1444e51719ec9fd23186c146b2a81c1fad3837e356a4f734c8bda185117` |
| `packages/loopy/src/core/store.ts` | 1 | 0 | `03e0a6c0cfb5e7723251976eb13851fee4d1181fb0ac4219c234be3e63ca0b50` |
| `packages/loopy/src/host/activate.ts` | 9 | 17 | `71944a1fbee7f527ac641ff41dca935a9fd290d0dc252ce7236b2356cdd88de0` |
| `packages/loopy/src/host/activation-plan.ts` | 42 | 0 | `a4addedb82e85bc6f22c317e34ee524eda9ac0304da24ed101bef5b07f8f99aa` |
| `packages/loopy/src/host/activation-work.ts` | 22 | 30 | `933e388aa1cbcdf6f6f96ecd4a3618a78f3cef1407756993b6df8cd31a247b65` |
| `packages/loopy/src/host/completion-event.ts` | 20 | 0 | `9a17b7e338ce0e345d70d092aa40df299d37fa5a76111fd150bedd62da0173f0` |
| `packages/loopy/src/host/durable-work.ts` | 18 | 60 | `b69a0b2bad5d04a2e44dea957941d9c2b0a45aeedda843238248b18ac14fd78a` |
| `packages/loopy/src/host/durable.ts` | 11 | 25 | `2abe93ce559fc24e920a1f01160bcabe1657882ff3d4f96d51670ea99ecfeae1` |
| `packages/loopy/src/host/rate-limit.ts` | 32 | 64 | `7ed185dbd214a075b74dcd232e6034719863714bfc3d752d75ffc6fbbf3c83e1` |
| `packages/loopy/src/store/memory-nodes.ts` | 10 | 1 | `5463625c0ee801ab52bffa207c52b32f3d0a48f9c0608caa3a02bc6a5d35de2d` |
| `packages/loopy/src/store/sqlite/nodes.ts` | 10 | 1 | `94352f8bed15222f529dd018aa2e1349dee9f095979f04bf4ec88974ace8385a` |
