# Receipt persistence assessment

Assessment only, at `6ffecdfd60e16aaa335467684d918b3cd8b44813` on `cloud-integration`. This note is the only file owned by this task. No application runtime or service was started, and no implementation, tests, API requests, Docker commands, cloud calls, personal-state access, main changes, commits or delegation were performed. Read AGENTS, unslop, TypeScript craft and its architecture/test/review references, worktree guidance, and the documentation authoring guidance. The requested repository destination overrides the documentation tool's external storage workflow.

## Recommendation for this round

Extract two contracts. A local execution receipt store handles the trusted child process's files. A sandbox attempt authority handles atomic admission, completion and workspace export exclusion. Share identity/result schemas and invariant scenarios where their meaning matches. Keep PID recovery and Docker recovery separate. Neither needs a general storage plugin system.

Implement both filesystem and actual local Durable Object SQLite sandbox authorities. Wire the latter into the repeated Wrangler plus Docker workload through an explicit startup selection. Store its bounded immutable terminal result bytes in local R2, with SQL holding the authoritative receipt and hash/size pointer. Docker still executes commands and owns mutable run volumes. R2 does not replace that workspace.

Fable 5.1 should review the proposal before production edits. Parent owns that review, implementation, verification and integration. This assessment authorizes no remote deployment or provider work.

## What the source currently guarantees

- `packages/loopy/src/host/activate.ts` commits durable effects before `ActivationWork.dispatch`. `host/durable.ts` and `durable-work.ts` also commit running state before provider admission, look up before starting, preserve known started effects, and fence host writes with the run owner token and execution key/attempt. Keep those owners unchanged.
- `executor/receipts.ts:82-109` exclusively creates and fsyncs a started file, then fsyncs and renames a finished file. `executor/execution.ts` writes started inside the trusted child before performing work. `executor/local.ts:25-69` validates receipt identity, probes its PID, rereads after death, and records `uncertain`. `executor.test.ts:176` covers a child finishing after its caller dies. Receipt persistence cannot move solely into the parent.
- Sandbox `receipts.ts` validates bounded regular receipt files with `O_NOFOLLOW`, exclusively creates started receipts and atomically replaces them on completion. `attempts.ts:118-165` pins canonical request hash, exact identity, original resource names and absolute deadline before Docker calls. Hashing includes the state root. Same-run workspace names also include that root.
- Sandbox exclusivity is a composition today. `Attempts.open` acquires `lockStateRoot`; `admissions` serializes duplicate HTTP requests; `artifactReads` blocks new same-volume work. `ReceiptStore.finished` itself has no expected-owner or expected-state comparison. Injecting that class's four file methods alone would omit the actual concurrency contract.
- `attempts.ts:222-244` preserves started receipts on backend/storage failure and retries original-container recovery with bounded backoff. `docker.ts` never repeats start during recovery. It checks labels, removes a never-started container before declaring uncertainty, monitors the saved deadline, and confirms stopping before publishing a timeout. A request conflict remains a conflict after completion.
- `attempts.ts:183-219` fences exports in memory, waits for admissions and scans pending receipts. `artifacts.ts` also checks mounted container states, uses the receipt's volume and checks helper ownership before removal. `artifact-worker.ts` pins directory descriptors, rejects symlinks/nonregular files, bounds reads and detects metadata changes. Exports are current run-workspace reads, not historical attempt snapshots.
- `apps/cloud/wrangler.jsonc` currently binds only `Workspace` and `ARTIFACTS`. `SandboxProvider` calls the Bun sandbox; that service unconditionally constructs a filesystem store. Existing workerd SQL/R2 tests exercise run storage and compiled artifacts, not an alternate sandbox receipt authority.

Two source-level export gaps need explicit treatment in the extraction. Restart loses `artifactReads`, and `readArtifact` removes its guard in `finally` even if Docker helper cleanup failed. A durable export record must remain until helper absence is confirmed. These are assessed failure paths, not newly executed reproductions.

## Local child receipt contract and composition

Keep these interfaces in `executor/`, exported through its existing entry. The schemas remain at the serialization boundary; infer stored receipt types from schemas. Reuse the existing shared execution-result schema rather than retaining the second handwritten result schema in `executor/receipts.ts`.

```ts
type AttemptIdentity = { executionKey: ExecutionKey; attempt: number };
type LocalReceipt = z.infer<typeof localReceiptSchema>;
type StartLocalReceipt = Extract<LocalReceipt, { kind: "started" }>;
type FinishedLocalReceipt = Extract<LocalReceipt, { kind: "finished" }>;

interface ExecutionReceipts {
  read(identity: AttemptIdentity): Promise<LocalReceipt | null>;
  claim(value: StartLocalReceipt): Promise<
    | { kind: "created" }
    | { kind: "existing"; receipt: LocalReceipt }
  >;
  finish(value: FinishedLocalReceipt): Promise<FinishedLocalReceipt>;
}
```

`localReceiptSchema` retains the current identity fields and `started + pid | finished + result` union. `claim` is exclusive and durable before it returns created; EEXIST reads the winning record rather than executing. `finish` publishes once and returns the winning terminal receipt. It cannot overwrite an existing terminal result. Do not expose a generic replace-file method as the semantic contract.

Use a filesystem adapter in both `LocalExecutor` and `ExecutionWorker`. Inject the adapter into these classes in process. The trusted worker entry reconstructs it from a parsed serializable descriptor `{ kind: "filesystem", home: string }`; never try to serialize the injected object on stdin. The daemon composition supplies the descriptor. Bundle execution receives neither the receipt adapter nor its descriptor, authority token, R2 binding, daemon credentials or protected-home access. Keep the existing restricted execution host and redaction paths.

The local state machine stays `absent -> started -> finished`. Only the child that wins claim performs work. The parent may synthesize terminal uncertainty only after confirming worker death and rereading. Killing the parent does not revoke the living child's ability to finish. PID reuse remains a limitation of the current identity check; this extraction does not claim to solve process birth identity or arbitrary detached descendants.

A concrete filesystem option for terminal immutability is a fsynced temporary file hard-linked exclusively to an attempt's terminal sibling, followed by directory fsync. Readers check terminal first, then the existing receipt path. Keep old completed receipt files readable because retained saved data exists. Validate identity and fail closed on disagreeing terminal representations. Keep original started files as admission tombstones. This narrow old-format reader is justified by retained data; do not add a general compatibility layer. Verify hard-link behavior on supported local filesystems before choosing it. If implementation keeps replacement instead, it must provide an equally concrete cross-process conditional publication mechanism; an in-memory mutex is insufficient for child and parent writers.

## Sandbox authority contract

Put browser-safe command/response schemas in `contract/sandbox-journal.ts` and export through `contract/index.ts`. Put the filesystem implementation and lifecycle composition in `apps/sandbox`. Put DO SQLite and R2 implementations in `apps/cloud`. Keep cloud SDK, SQL and filesystem imports out of contract/core/engine. Keep `AttemptBackend` and `ArtifactReader` Docker-specific for this round; there is no second execution provider to justify a generic provider record.

The new internal schemas should define these exact records, with types inferred from them:

- `AuthoritySession`: `{ epoch: positive integer, nonce: nonempty string }`. It is independent of the host run-owner token.
- `DockerAttemptPlan`: the current started receipt's `id`, `requestHash`, `workspace`, complete `executionKey`, positive `attempt`, exact `container`, `inputVolume`, `volume` and absolute positive integer `deadline`. Resource fields retain their existing validation. The plan is immutable.
- `ResultRef`: `{ sha256: hashSchema, size: positive integer <= SANDBOX_MAX_CAPTURE_BYTES }`. Its key is derived by the adapter under the authority/workspace namespace, never accepted as an arbitrary R2 key from a request. Cap canonical serialized result bytes at the existing 2 MiB capture limit, including logs and JSON overhead. Normalize excess into a small failed `output_limit` result before publication, rather than retaining a permanently unpublishable started result.
- `ResultLocation`: `{ kind: "blob", ref: ResultRef } | { kind: "inline", value: SandboxExecutionResult }`. New completions use blob references. Inline is solely the read representation for existing filesystem terminal receipts, so opening retained data does not rewrite it.
- `AttemptRecord`: `{ kind: "started", plan } | { kind: "finished", plan, result: ResultLocation }`. Finished never becomes started or absent.
- `ExportRecord`: `{ token: nonempty string, session: AuthoritySession, attemptId: hashSchema, volume: existing volume-name schema, helper: exact artifact helper name }`. It persists until confirmed cleanup. No expiry grants admission.
- `AuthorityFailure`: closed codes `request_conflict | workspace_busy | stale_session | missing | invalid_state`. Malformed persisted bytes and transport/storage failures throw and must never become `none` or a fresh admission.

The operation signatures are below. Names refer to the inferred records above. The actual RPC schemas must preserve each operation's specific reply union instead of using a generic transport cast.

```ts
interface SandboxAttemptAuthority {
  status(): Promise<{ epoch: number }>;
  openSession(input: { expectedEpoch: number; nonce: string }): Promise<AuthoritySession>;
  read(id: string): Promise<AttemptRecord | null>;
  admit(input: { session: AuthoritySession; plan: DockerAttemptPlan }): Promise<
    | { kind: "created"; record: Extract<AttemptRecord, { kind: "started" }> }
    | { kind: "existing"; record: AttemptRecord }
    | { kind: "rejected"; code: AuthorityFailure }
  >;
  complete(input: {
    session: AuthoritySession;
    id: string;
    requestHash: string;
    result: ResultRef;
  }): Promise<
    | { kind: "finished"; record: Extract<AttemptRecord, { kind: "finished" }> }
    | { kind: "rejected"; code: AuthorityFailure }
  >;
  beginExport(input: {
    session: AuthoritySession;
    attemptId: string;
    token: string;
  }): Promise<
    | { kind: "granted"; record: ExportRecord }
    | { kind: "rejected"; code: AuthorityFailure }
  >;
  endExport(input: { session: AuthoritySession; token: string }): Promise<void>;
  recoverable(input: { after: string | null; limit: number }): Promise<{
    attempts: Extract<AttemptRecord, { kind: "started" }>[];
    exports: ExportRecord[];
    next: string | null;
  }>;
}

interface ImmutableResults {
  put(result: SandboxExecutionResult): Promise<ResultRef>;
  get(ref: ResultRef): Promise<SandboxExecutionResult>;
}
```

Keep `recoverable` pagination bounded and stable, for example a tagged key ordering across attempt and export records with one combined limit. Startup keeps admissions closed until every retained export guard is recovered. Missing or malformed result content is a storage failure, not permission to rerun. `endExport` is idempotent for its own released token and rejects a stale session; it cannot remove another token's guard. The caller must confirm helper absence before invoking it.

### Atomic operations and transitions

1. Open a session only after taking the existing exclusive OS state-root lock. In SQL, compare `expectedEpoch` and increment once. Retrying the current nonce returns its existing session; an older delayed open with a different nonce/old epoch fails. Restart rotates the session and fences old completion/export mutations, while retaining the original plans and deadlines. Status returns zero for an initialized authority with no prior session and the current epoch otherwise. There is no time-based automatic takeover of the Docker bridge.
2. Admit in one authority transaction. Check session, then existing identity/hash first. A matching existing record returns existing, including during export. A changed hash returns request conflict. For an absent identity, reject a same-volume export guard, then insert started. Only a positively received created response permits one `backend.start`. An RPC timeout or lost admission acknowledgement permits read/recover only. Repeating admit returns existing and never reissues create authority. This deliberately may fail an unlaunched admitted attempt as uncertain after a crash.
3. Keep the current canonical request hashing, sorted bundles, complete scope identity and absolute deadline calculation. Compute the deadline only for a new plan. Existing records retain their saved value. A trusted authority validates that derived identity/resource names match its namespace. Neither HTTP callers nor result payloads can choose another attempt's resources.
4. Backend start stages input, creates and starts the pinned Docker container once. Backend recovery never creates/stages/starts. Transport errors retain started and reconcile the same names. A missing/unstarted worker becomes terminal uncertainty only under the existing conservative Docker reconciliation policy. Preserve label checks and never reuse removed attempt names. Inspection absence is not a provider-wide cancellation proof for arbitrary delayed creates.
5. Once Docker confirms a terminal condition, bound and serialize the result, publish immutable bytes, then call complete. SQL compares current session, identity/hash and started state. Matching terminal replay returns the existing terminal record; a different terminal digest is rejected and never overwrites it. Losing the completion response is resolved by reading the authoritative record. Keep a successfully observed result in memory through a transient result-store/complete failure rather than replacing it with a fresh recovery outcome. After a bridge crash, recover the original container and retry publication.
6. Begin export in the same authority transaction that checks a finished target receipt, no started attempt sharing its volume, and no other export guard. Persist exact helper identity before helper creation. The guard blocks all new same-volume admissions. After reading, verify/remove the owned helper and confirm absence before endExport. If cleanup or release is ambiguous, keep the guard. Restart removes or reconciles that exact helper before releasing its retained guard, then opens admissions. Keep mounted-container inspection and descriptor-based reading as a second defense. SQL metadata cannot prevent an unrelated external Docker writer.

## Filesystem and DO implementations

The filesystem sandbox authority keeps the existing exclusive state-root process lock. Move admission/completion/export coordination into one authority-owned serial queue, including conditional rereads, durable started writes, terminal publication and export-marker writes. A fsynced exclusive marker under a checked private export directory makes export fencing survive service death. This is a single locked-process transaction boundary, not a filesystem claim of arbitrary multi-host transactions. The local child store above has a different cross-process writer model.

At the filesystem decode boundary, wrap existing `StoredReceipt` fields into the plan and existing terminal bodies into inline result locations without writing them back. New filesystem receipts can carry a versioned blob-reference envelope. Public receipt projection resolves either location once. Compute the same canonical digest for an existing inline terminal result when comparing a repeated completion. This narrow retained-data decoder has a real caller; it is not a second admission path. New DO records need only the blob variant.

The DO authority uses a separate `SandboxReceipts` class and `SANDBOX_RECEIPTS` binding. Preserve the `Workspace` migration and append a local SQLite-class migration. One object per configured sandbox state-root namespace is the smallest match for today's one locked bridge. Its separate schema contains authority metadata, attempts and export guards, with attempt ID primary key and indexes on started volume and recovery cursor. `ctx.storage.transactionSync` must atomically perform each operation; no Docker calls, R2 awaits or network waits inside that transaction. Reuse `DurableSqlDriver` if useful, without constructing `SqlRunStore` for this unrelated schema.

Add authenticated internal receipt/result routes before normal principal-to-Workspace routing. Keep the existing loopback and local-stage checks. Authenticate with the sandbox bridge token, never accept that token as a user principal, scope requests to the configured authority namespace, and bound/parse commands once. Route directly to the separate receipt object. Otherwise `Workspace -> sandbox -> same Workspace` can deadlock behind `Workspace.serial`. The sandbox's HTTP adapter parses responses and injects an authority instance into `Attempts`.

Use one parsed configuration union, such as filesystem persistence or local durable persistence with loopback URL, authority namespace and private token supplied by the trusted launcher. `Attempts.open` takes explicit dependencies rather than silently constructing `ReceiptStore`. The entrypoint composes production defaults. Do not fall back to filesystem if the selected durable authority is unavailable. Keep the OS root lock for both selections; SQL session fencing protects journal writes, not the Docker daemon from a stale process issuing commands. Multi-host or overlapping bridges are outside this round.

Startup order is validate owned root, acquire OS lock, compose dependencies, open authority session, recover export guards, start monitoring all pending plans, then accept requests. Shutdown first stops admission, waits for all admission operations, aborts monitoring without terminalizing unknown work, drains artifact operations or retains their durable guards, and releases the OS lock last. Current close drains active monitors and artifact operations but not the admissions map; the new owner must close that gap.

### Why R2 is a byte store

R2 conditional create is useful for immutable content, as the current `ArtifactStorage.put` and local R2 tests already show. It does not by itself implement the transaction across identity/hash comparison, started records, session fencing and same-volume export exclusion. Building that coordination from object reads and writes would duplicate the authority protocol. Use SQL for those transitions.

R2 result payloads are justified in the DO path because results already permit roughly a MiB of output plus bounded logs. They keep mutable SQL records small and exercise real alternate result persistence. Use bounded canonical result serialization and a workspace-scoped content hash key. Compose `ImmutableResults` per authority namespace and trusted `plan.workspace`, for example through `resultsFor(workspace)`, so a digest alone never selects another tenant's object. Verify existing bytes on conditional-create collision; verify length/hash/schema on read. The filesystem implementation can use the same immutable-result contract with private content-addressed files, keeping large bodies out of authority records there too.

Publish bytes before the SQL terminal pointer. A crash after blob publication may leave an orphan, which is acceptable for this bounded round. A committed pointer must resolve to valid bytes. Do not delete blobs, receipts or admission tombstones in this change. Mutable artifact exports keep using the trusted Docker reader. Persisting arbitrary workspace artifacts to R2 is deferred because it would require a new snapshot/version contract and adds no admission guarantee here.

## Exercise the actual alternative

Parent's implementation must add the real binding, route and launcher selection together. The repeated cloud workload must choose durable receipts explicitly and record that selection, namespace, source hashes and fresh Wrangler persistence path. Starting Wrangler with DO/R2 bindings while the sandbox still writes filesystem receipts does not satisfy acceptance.

Use new named local state and unused ports for Wrangler, sandbox and dashboard. The current `validateStateRoot` requires exactly `<worktree>/.loopy/cloud/sandbox`, so safely parameterizing the owned local state layout is part of the launcher/config change. Accept an explicit validated manifest whose sandbox root is an exact child of the new named workspace-local root. Preserve component-by-component symlink checks and the no-personal-home rule. Do not loosen it to any arbitrary absolute path. Derive Docker labels, receipt IDs and workspace volumes consistently from this new root.

Run the same 525 primary cloud-shaped runs plus their three separate preflights, and 45 local daemon runs, after review and implementation. The 525 cloud runs must flow through DO admission, Docker execution and R2 terminal publication/readback. Include restart, duplicate/conflict, lost acknowledgement, deadline and artifact-exclusion checks in separate bounded scenarios; ordinary successful workloads cannot establish those cases. Inspect actual DO rows and hash-verified result objects against workload IDs. Verify no new sandbox receipt JSON files are acting as authority in durable mode, while allowing locks and staging files. Local daemon executions exercise the filesystem child adapter.

`cloud-worker.test.ts` already shows local workerd SQLite/R2 setup. Extend that fixture pattern for the new authority, then also run the actual Wrangler launcher path. An in-memory SQL fake or a DO class with no runtime caller is insufficient. Tests should reopen the same disposable persistence directory across runtime reconstruction, rather than only constructing a second wrapper over the same live object. This provides local persistence evidence, not remote replication or physical-disk crash proof.

## Existing saved data and cutover

Leave `.loopy/cloud`, `.loopy/playground`, `.loopy/playground-daemon`, original exports, receipts, volumes, credentials and evidence untouched. The assessment did not inspect those datasets. Historical counts in tracked notes are context, not a fresh inventory. Do not run migration, restart an old stack, or create a backend-selection marker in an old dataset during this round's fresh-state workload.

Keep filesystem selection available for the existing sandbox receipt schema and retain old local child receipt reads. A receipt refactor alone does not justify changing daemon run-store schema 15, epoch, run IDs, graph revisions, logs, hooks or event cursors. `store/sqlite/local-schema.ts` currently upgrades 13/14 to 15 and rejects unsupported populated databases; the portable initializer checks its separate meta version. Preserve both behaviors. Parent's read-model work may own a separate explicit schema migration; receipt code must not reset or reinterpret that store.

For any later switch of a populated filesystem dataset to durable authority, require a concrete stopped-source import plan, not an empty new journal. Read bounded old receipts without modifying them, verify complete identities/hashes and archive a manifest, and import terminal result blobs before terminal pointers. Preserve original attempt IDs, request hashes, deadlines, resource names and Docker owner namespace. The source-root hash cannot silently become a different target-root hash. Started records import as recovery-only and never receive a created grant. Import must be idempotent and staged, verify counts/digests/conflicts before activation, and reject mixed source/target use. No dual-write or automatic fallback. The fresh-state implementation can defer that importer, but must refuse selecting an empty durable authority for an existing populated filesystem root. Preserve old data and explain the required offline import instead.

## Which earlier failures this boundary addresses

- The phase-1 Docker transport finding was a lifecycle design error: a backend exception was treated as terminal despite a live worker. Current code repairs it by retaining started and recovering. Encode that distinction in the authority/lifecycle contract; changing disks would not have fixed it.
- Interrupted suspension was a scheduler selection case. The host knew how to recover but the scheduler excluded owned suspended runs. Invalid-schedule workspace blocking came from a shared catch/iteration boundary. Both require scheduler scenarios; neither is caused by filesystem receipts.
- Aggregate artifact capacity was a write/read contract mismatch. Accepted state could exceed a later bounded list read. Keep capacity checks with artifact publication and bound receipt/result reads independently.
- The pending-hook SQL bind failure, remaining map-page bind gap at `store/sqlite/query-nodes.ts:122`, and daemon admission wake delay are missed backend-scale or event-delivery cases. Receipt DI will not repair them. The parent's read-model/runtime owners should retain their separate fixes and negative controls.
- The workload guard's earlier catch/acquisition issue and the probe's journal publication/admission issues are tooling boundary failures, documented in the tracked reviews. Do not present them as production receipt defects or rewrite those systems in this round.
- The proposed extraction addresses hidden process-lock assumptions, terminal write fencing and durable export lifecycle directly. It does not establish general exactly-once external effects, PID birth identity, remote bridge recovery, or provider-enforced lifetime during total monitor outage.

## Contract and model tests worth adding

Keep tests under `packages/loopy/_tests_`. Parameterize the sandbox authority scenarios over filesystem and real local DO implementations. Parameterize immutable-result scenarios over filesystem and local R2. Reuse scenario definitions, not a shared implementation masquerading as the oracle. Test the local child receipt contract separately where PID/process semantics differ.

Build a small independent reference model using sets/maps of admitted identities, immutable request hashes, committed result hashes, current session and volume export tokens. Its operations describe externally observable transitions and an execution-start count; it must not import the production transition helpers or SQL builders. Enumerate short sequences and seeded longer traces of admit, duplicate/conflict, finish, session rotation, export and restart. For concurrent commands, compare results to permitted serial orders. Scope the claim to that finite model and tested adapter behavior.

Required cases and targeted negative controls:

- Failure before durable admission yields zero backend calls. Success followed by lost admission response yields one receipt and no replacement start. Moving dispatch before commit or treating existing as created must fail.
- Concurrent identical admissions yield one created grant; changed spec or bundle content conflicts before and after finish. Workspace, complete ordered scopes and attempt isolate identity. Omitting request-hash comparison or a scope component must fail.
- A new session recovers the original plan/deadline and rejects old-session terminal/export writes. An old attempt cannot complete a newer host attempt. Removing session comparison or host attempt/owner fencing must fail at the layer that owns each rule.
- Lost create/start/wait responses recover the original named resource and never re-enter backend start. Missing or invalid terminal state remains uncertain under existing retry policy. Mutating recovery to start again must fail a start-count/effect-marker assertion.
- Advance past the saved deadline after reconstruction; inspect/kill only the labelled original container and confirm stop before timeout completion. Resetting deadline or dropping monitoring after transport failure must fail.
- Result publication failure leaves started; a blob orphan does not create a terminal receipt; lost SQL completion response replays the original result. Missing, oversized, malformed or hash-mismatched blobs throw without re-admission. Publishing SQL first or converting unavailable storage to none must fail.
- Race export with same-volume admission. Persist an export guard, kill/reconstruct its bridge, and verify admission stays blocked until the owned helper is absent. Inject cleanup failure and stale endExport. Releasing in finally, expiring a guard, or deleting by volume/name prefix must fail. Different run volumes should still progress.
- Real local children compete for claim; only the winner performs the effect. Kill the parent after started durability and observe the surviving child finish. Kill the child and reconcile uncertainty without rerunning. Competing terminal publishers cannot replace the winner. Existing receipt security/redaction and saved-data readers remain covered.

Retain existing host local/durable tests for persist-before-dispatch, retries, stale completion, leases and logs. Share a host scenario only if both execution APIs have the same observable invariant; local blocking execution and durable prompt-return admission are intentionally different. Existing cloud tests often inject `AttemptBackend` or `CommandRunner`; those remain useful Docker lifecycle tests, but do not substitute for actual journal transactions, R2 failures, independent subprocess writers or restart persistence.

Parent should report each negative control's observed failing assertion, then restore it and run the focused suites plus full `bun run check`. Workload evidence supplements those checks. No test execution or mutation control was run for this assessment.

## Smallest implementation order and risks

1. Review this contract/lifecycle proposal with Fable before editing production code.
2. Extract/inject the local filesystem receipt owner and sandbox filesystem authority, deleting direct receipt calls/maps once their ownership moves. Add conditional terminal publication and durable export cleanup fencing with focused tests.
3. Add the separate DO authority, immutable R2 results, authenticated local routes and explicit launcher selection as one usable path. Keep Docker backend behavior and public receipt API unchanged. Add actual adapter/model/reconstruction checks.
4. Use fresh state for the requested repeat workload and saved-data equivalence checks, then independent implementation review and full repository gate before parent integration.

The main risks are delayed Docker operations crossing a bridge restart, result-pointer publication order, export helpers surviving crashes, shutdown racing admission, and accidentally recomputing root-derived identity. Retaining the local process lock bounds the first risk to today's single-host bridge model; SQL alone cannot enforce Docker multi-owner safety. Saved deadlines survive restart, but Docker has no independently demonstrated provider-enforced lifetime while every monitor is down. R2/SQL availability failures must reduce liveness, never permit replay. Keep these limits explicit when interpreting the 525/45 workload.
