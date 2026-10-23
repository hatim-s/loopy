---
title: Sandbox attempt authority and filesystem lifecycle implementation
status: focused validation complete, live acceptance remains with root
date: 2026-10-23
starting-head: 6ffecdfd60e16aaa335467684d918b3cd8b44813
---

## Result and scope

Implemented the adapter-neutral attempt authority contract, filesystem authority and immutable results, and injected bridge lifecycle. The accepted proposal and Fable B1/B3 corrections govern this change. No main changes, commits, pushes, cloud calls, real Docker launches, personal dataset reads, existing test-root mutations, children, or broad fullcheck were performed. Tests created fresh temporary worktrees under the system temporary directory. Their loopback server and process-capture fixtures are disposable and do not use shared services.

Ownership excludes `apps/sandbox/src/http-authority.ts`, cloud implementations, harness selection, and all index exports. Those files belong to other lanes. The selected durable factory must reject a populated filesystem receipt directory under the acquired lock. Root and the harness lane accepted ownership of that check. There is no runtime adapter fallback. The filesystem default is a concrete production composition at `startSandbox`.

## Frozen public contract

The shared files are `packages/loopy/src/contract/sandbox-journal.ts` and `sandbox-journal-rpc.ts`. Types are inferred from schemas. Root owns their `contract/index.ts` exports.

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
    session: AuthoritySession; id: string; requestHash: string; result: ResultRef;
  }): Promise<
    | { kind: "finished"; record: Extract<AttemptRecord, { kind: "finished" }> }
    | { kind: "rejected"; code: AuthorityFailure }
  >;
  beginExport(input: {
    session: AuthoritySession; attemptId: string; token: string;
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
type ResultsFor = (workspace: string) => ImmutableResults;
```

`AuthoritySession` has a positive integer epoch and a nonce of 1 through 256 characters. The filesystem epoch is constant one during an open instance. Each bridge open generates a new UUID nonce. Only the DO claims persistent epoch CAS. Both started and finished `AttemptRecord` variants carry the original admitting `session` and immutable `plan`. Finished adds `result`. A result location is either a blob `ref` or an inline `value` for retained filesystem receipts. `ResultRef` contains SHA-256 and positive byte size at most `SANDBOX_MAX_CAPTURE_BYTES`, currently 2 MiB. Plans retain the existing identity/resource validations and a positive integer deadline.

`ExportRecord` contains `token`, admitting `session`, `attemptId`, exact `volume`, and exact `loopy-artifact-<attemptId>` helper. Tokens are 1 through 256 characters. Failure codes are `request_conflict`, `workspace_busy`, `stale_session`, `missing`, and `invalid_state`. `AuthorityError(code)` represents rejected session-open/export-release operations. Storage, malformed data, and transport exceptions remain failures and never imply absence.

Exports in the record file are `authoritySessionSchema`, `dockerAttemptPlanSchema`, `resultRefSchema`, `resultLocationSchema`, `startedAttemptRecordSchema`, `finishedAttemptRecordSchema`, `attemptRecordSchema`, `exportRecordSchema`, `authorityFailureSchema`, the inferred record types, `AuthorityError`, `ImmutableResults`, and `ResultsFor`.

RPC exports are `authorityOperations`, `resultOperations`, `authorityCommandSchema`, `authorityErrorSchema`, `AuthorityInput<K>`, `AuthorityOutput<K>`, `AuthorityCommand`, and `SandboxAttemptAuthority`. The request envelope is `{ operation, input }`. Each operation preserves its specific reply schema. `resultPut` input is `{ workspace, value }`, output `ResultRef`. `resultGet` input is `{ workspace, ref }`, output `SandboxExecutionResult`. `endExport` uses JSON null for its void wire response. Rejected thrown authority operations use `{ error: AuthorityFailure }`. The separately owned client/Worker use POST `/internal/sandbox-receipts` and `X-Loopy-Receipts-Namespace`.

## Injection and lifecycle signatures

```ts
interface AttemptDependencies {
  authority: SandboxAttemptAuthority;
  resultsFor: ResultsFor;
  backend: AttemptBackend;
  artifactReader: ArtifactReader;
  close?: () => Promise<void>;
}
type AttemptDependenciesFactory = () => Promise<AttemptDependencies>;

Attempts.open(
  config: SandboxConfig,
  createDependencies: AttemptDependenciesFactory,
): Promise<Attempts>;

startSandbox(
  input: SandboxConfig,
  createDependencies?: AttemptDependenciesFactory,
): Promise<{
  server: Bun.Server<undefined>;
  attempts: Attempts;
  close: () => Promise<void>;
}>;

filesystemDependencies(
  config: SandboxConfig,
  overrides?: { backend?: AttemptBackend; artifactReader?: ArtifactReader },
): AttemptDependenciesFactory;

interface ArtifactReader {
  cleanup(receipt: DockerAttemptPlan, helper: string): Promise<void>;
  read(
    receipt: Extract<StoredReceipt, { kind: "finished" }>,
    path: string,
  ): Promise<SandboxArtifact>;
}
```

The dependency callback runs only after strict root validation and OS-lock acquisition. The filesystem factory creates `FilesystemAuthority(root)` and `FilesystemResults(root, workspace)`, and closes its authority before releasing the lock. The authority implements the interface above and additionally exposes `close(): Promise<void>`. Closed instances reject later mutations. The public `/attempts` and `/artifacts` wire APIs remain unchanged. Existing internal `Attempts.open(config, backend, reader)` calls must use the explicit filesystem factory.

## Changed semantics

- Admission, completion, and export mutations execute in one filesystem authority queue under the existing OS process lock. Immutable plans and admitting sessions are persisted before backend effects. Duplicate requests return the original record; changed content conflicts.
- A lost admit response retains the request and its per-id gate. If resolving reads are unavailable, it retries at 100 ms doubling to a 5 second cap until available or shutdown. A matching started record from the current session can issue start once. The issued marker is set synchronously before calling the backend. Another session always recovers. Docker name conflicts are a secondary defense.
- An absent resolving read can precede a delayed remote admit commit. The matching request/hash remains retained in this session. A later lookup or start can issue its first start once the current-session record appears. Both the later-start and lookup-first orders have isolated fault tests. Cross-session and already-issued records remain recovery-only.
- Only verified admitted records enter the monitor map. Twenty lookups of a monitored id caused zero authority reads in the focused test. Unmonitored lookups still consult authority, and terminal values resolve only from authoritative finished records.
- A terminal observation stays in memory through immutable-byte and pointer-publication failures. Recovery cannot replace that observation with uncertainty. Bounded result serialization normalizes oversized terminal metadata into a small `output_limit` failure.
- New results use workspace-scoped content-addressed files. File bytes and directory entry are fsynced before publishing the terminal pointer. Filesystem `complete` verifies the referenced bytes before writing a new pointer. Existing terminal hashes cannot change. A private temporary inode is exclusively linked for immutable byte creation; this does not change the local child receipt protocol or add another terminal receipt file. Journal records retain atomic rename.
- Old flat filesystem started/finished receipts decode into plans with a reserved recovery session and inline terminal results. Reads do not rewrite retained files. Existing legacy schema exports remain because these files have real readers. The old mutable `ReceiptStore` implementation is deleted.
- Export exclusion persists before helper creation. Cleanup verifies exact name and owner/request/role labels, removes the helper, and confirms absence. A failed or ambiguous cleanup retains its guard and returns conflict. Startup and later same-volume requests retry reconciliation. Unrelated volumes progress.
- Released export tokens have durable inactive metadata written before active guard removal. They cannot be re-granted, and a delayed release cannot clear a newer token.
- Release validates the current caller session and exact token. A successor can clear an older guard after confirmed helper absence. Foreign tokens release nothing. Guard volume/helper metadata is checked against the admitted attempt.
- Shutdown aborts admission first, settles all retained admission gates, drains monitors and artifact operations, closes the dependency lifecycle, and releases the process lock last. Close is idempotent. State-root path validation remains exact; only checked private `exports` and `results` sibling directories were added.

## Verification

Focused command, final output `28 pass`, `1 skip`, `0 fail`, `1487 expect() calls`, across seven files:

```sh
bun test packages/loopy/_tests_/cloud-sandbox.test.ts packages/loopy/_tests_/sandbox-authority*.test.ts
```

The skipped test is the pre-existing opt-in real-Docker scenario. Existing sandbox coverage retained all twelve non-Docker tests. No existing test was deleted or moved. Existing tests were adapted to explicit dependency injection and the new persisted envelope. New tests live under `_tests_`, with three dedicated fixtures.

The independent model imports no production transition helper or schema as an oracle. Bounds are two sessions, three attempt identities, two terminal digests, one export token and thirteen actions. Two identities share one volume; the third uses another. Breadth-first exploration to depth seven reached 56 states and 702 transitions. All 55 shortest representative traces were replayed through the actual filesystem authority with 1238 assertions. This is a finite contract check, not an unbounded execution or provider proof.

Focused formatting and lint passed on the 29 owned TypeScript files with these exact commands:

```sh
bunx biome check apps/sandbox/src/admission.ts apps/sandbox/src/artifacts.ts apps/sandbox/src/attempt*.ts apps/sandbox/src/config.ts apps/sandbox/src/receipts.ts apps/sandbox/src/result.ts apps/sandbox/src/server.ts apps/sandbox/src/filesystem*.ts apps/sandbox/src/immutable-results.ts apps/sandbox/src/journal-files.ts packages/loopy/src/contract/sandbox-journal*.ts packages/loopy/_tests_/cloud-sandbox.test.ts packages/loopy/_tests_/sandbox-authority*.test.ts packages/loopy/_tests_/fixtures/sandbox-authority*.ts
bunx eslint apps/sandbox/src/admission.ts apps/sandbox/src/artifacts.ts apps/sandbox/src/attempt*.ts apps/sandbox/src/config.ts apps/sandbox/src/receipts.ts apps/sandbox/src/result.ts apps/sandbox/src/server.ts apps/sandbox/src/filesystem*.ts apps/sandbox/src/immutable-results.ts apps/sandbox/src/journal-files.ts packages/loopy/src/contract/sandbox-journal*.ts packages/loopy/_tests_/cloud-sandbox.test.ts packages/loopy/_tests_/sandbox-authority*.test.ts packages/loopy/_tests_/fixtures/sandbox-authority*.ts
``` Final Biome output was `Checked 29 files ... No fixes applied`; ESLint emitted no diagnostics. The exact owned-file set appears in the hash inventory below. Focused semantic typechecking passed with no diagnostics:

```sh
bunx tsc --noEmit --target es2022 --moduleResolution bundler --module esnext --strict --noUncheckedIndexedAccess --skipLibCheck --types bun-types apps/sandbox/src/*.ts packages/loopy/src/contract/sandbox-journal*.ts packages/loopy/_tests_/cloud-sandbox.test.ts packages/loopy/_tests_/sandbox-authority*.test.ts
```

That compilation includes the separately owned HTTP client through the sandbox glob, but did not edit it. `git diff --check` passed for the modified tracked files in this lane. No broad build/check ran. All new runtime files are at most 241 lines at this snapshot.

## Causal negative controls

Seven temporary production mutations were each run against the relevant focused test, observed to fail, and restored before the final green run.

| Mutation | Observed failure |
| --- | --- |
| Remove the admitting-session comparison before start | Older-session scenario expected zero starts and received one |
| Abandon the unresolved read after a dropped admit reply | Lost-ack test failed with `Authority read unavailable` instead of reaching its successful started/finished assertions |
| Clear the observed terminal result on publication failure | Expected succeeded result, received uncertain recovery result |
| Release an export guard in finally when helper cleanup fails | Expected one retained export guard, received zero while helper remained present |
| Disable the existing-finished conditional branch | Conflicting completion expected `request_conflict`, received a replaced finished result |
| Omit byte verification before a filesystem terminal pointer | Missing-byte completion expected rejection but resolved successfully |
| Drop the retained request after a null resolving read, then commit the admit late | Later lookup expected one start and received zero |

The session negative fixture deliberately changes the authoritative admitting session after a dropped reply to isolate the comparison. The ordinary restart scenario independently proves that a fresh bridge issues zero starts and recovers the old admission. The synchronous issued marker and retained gate remain additional defenses; the controls do not claim to independently defeat every redundant defense with a single mutation.

## Remaining acceptance limits

Root owns real local DO SQLite/R2 boundary proof, actual Docker lifecycle/restart behavior, fresh workload repetition, final integration review, and repository-wide gates. The separately owned DO adapter and HTTP boundary need their own contract tests and live local provider evidence. This lane establishes filesystem persistence and adapter-neutral bridge behavior with injected faults and command runners.

The filesystem authority assumes one locked local bridge. Its epoch is not multi-host fencing. PID reuse and a hung live predecessor can block startup. Result objects and admission tombstones are retained without garbage collection; crashes may leave orphan immutable bytes or ignored private temp files. Exact arbitrary external effects still require cooperation from those external systems. Docker has no independently established lifetime guarantee while all monitors are down. The retained admission reconciliation assumes eventual authority recovery or shutdown. A delayed commit that follows a successful absent read is discovered on subsequent delivered lookup/start opportunities. Cleanup ambiguity blocks that volume until recovery, while unrelated volumes remain available.

## Review P2 shutdown correction

Read `sandbox-review-1.md` and reproduced its server-level shutdown cycle before editing runtime. The new actual-server test failed after 750 ms with `Server shutdown waited for unavailable admission reconciliation`. Its authority committed admission, dropped the reply, and kept resolving reads unavailable. Calling `Attempts.close()` separately in test teardown safely drained the reproduction.

The runtime correction is exactly two lines added and one deleted relative to the reviewed server. It calls `server.stop(true)` to stop intake, retains that promise, calls and awaits `attempts.close()` immediately, then awaits the retained HTTP stop promise. The admission abort therefore runs while HTTP is draining. No authority signatures, session rules, monitor logic, artifact cleanup rules, or lock-release ordering changed. `attempts.ts` and `attempt-reconciliation.ts` retain their reviewed hashes.

Three actual ephemeral Bun-server tests now assert that the stalled handler and public close settle without authority recovery, zero backend starts occur, dependency close runs once, and the lock is absent after safe shutdown. Reopening the same isolated root recovers its old-session admission with zero starts. Separate tests hold a real backend promise or artifact-helper cleanup promise open, confirm new admission is rejected, and confirm the lock remains present through the drain and a separately gated dependency close. This rejects a fix that releases the lock merely to make close return.

Causal controls were temporary and restored. Restoring sequential HTTP-stop-before-abort failed the 750 ms liveness bound. Moving lock release before the bridge drain made both effect/helper tests fail with `Expected true, Received false` at the lock-presence assertion during dependency close. The final source has neither mutation.

All runs redirected TMPDIR into the new isolated `.loopy/architecture-tests/sandbox-shutdown-ob_s1taf/tmp` directory. Original review probes and existing workload state were not touched. Evidence logs are `.loopy/architecture-tests/sandbox-shutdown-ob_s1taf/before-fix.log`, `sequential-http-shutdown.log`, `premature-lock-release.log`, and `final-focused.log` in the same directory.

Final focused suite command used this TMPDIR and `bun test packages/loopy/_tests_/cloud-sandbox.test.ts packages/loopy/_tests_/sandbox-authority*.test.ts`. It passed `31 pass`, `1 skip`, `0 fail`, `1511 expect() calls` across eight files. The three new tests contribute 24 assertions. No real Docker test, workload, fullcheck, main mutation or commit ran. Root's earlier fullcheck result remains its separate evidence.

`bunx biome check apps/sandbox/src/server.ts packages/loopy/_tests_/sandbox-authority-shutdown.test.ts` printed `Checked 2 files ... No fixes applied`. The corresponding focused `bunx eslint` emitted no diagnostics. Focused semantic typechecking passed without output using `bunx tsc --noEmit --target es2022 --moduleResolution bundler --module esnext --strict --noUncheckedIndexedAccess --skipLibCheck --types bun-types apps/sandbox/src/server.ts packages/loopy/_tests_/sandbox-authority-shutdown.test.ts`. `git diff --check -- apps/sandbox/src/server.ts` passed.

Incremental source delta from the reviewed candidate is 232 added / 1 deleted lines, including the new 230-line test. Exact final hashes:

```text
7009a9e6cad6f7844e3de6d26db3edee2a25b4167db8bb61090682045482f985  apps/sandbox/src/server.ts
1de5c5d4436e686788427d2ef63494abdcf29e783ef548ca8223de894f24f848  packages/loopy/_tests_/sandbox-authority-shutdown.test.ts
a8bffa4bc58d35daf48e0b6e38bf2dbb975e54ccf3421a8d024b3d32edadeee1  apps/sandbox/src/attempts.ts
a774feb9b96a8abcd75afc0b43ccf3aa4b76e2e2d1254dedbfbe275e154bd9fa  apps/sandbox/src/attempt-reconciliation.ts
```

## File inventory

The following hashes and line deltas cover this lane's 30 TypeScript files only. They exclude the separately owned client, index exports, and other lanes. New files count all lines as added. The report itself is excluded from its own hash inventory.

| File | Added | Deleted | SHA-256 |
| --- | ---: | ---: | --- |
| `apps/sandbox/src/artifacts.ts` | 25 | 5 | `cb212a6856380946eb7a754a56be3e96393d9cc66fa0188c0ff177c6a779bff6` |
| `apps/sandbox/src/attempts.ts` | 110 | 186 | `a8bffa4bc58d35daf48e0b6e38bf2dbb975e54ccf3421a8d024b3d32edadeee1` |
| `apps/sandbox/src/config.ts` | 4 | 2 | `56e6737f4c79620d1f137258e3901622ee98c771f258c597e848922e33fe7ab9` |
| `apps/sandbox/src/receipts.ts` | 1 | 85 | `99b78e61d686aad65847cc59e2fc8776f5d9c83f099b40575292d57a7138d393` |
| `apps/sandbox/src/result.ts` | 9 | 2 | `b29698d5cdb79087f9407c7c6d31970887431b4f6e84bb8518e78a53a4494454` |
| `apps/sandbox/src/server.ts` | 13 | 4 | `7009a9e6cad6f7844e3de6d26db3edee2a25b4167db8bb61090682045482f985` |
| `packages/loopy/_tests_/cloud-sandbox.test.ts` | 28 | 8 | `1fc9bfd7410434e7236e99333bb4297303ae0dd8a42017a5f9d572a14d391f1e` |
| `apps/sandbox/src/attempt-admissions.ts` | 226 | 0 | `ee0feb62ce6f368a54668f8a648d07298b1d94f0c5c1b06821672f024b23bee8` |
| `apps/sandbox/src/attempt-dependencies.ts` | 14 | 0 | `086dc710a6520101b4da42e824c2fc0777bbafaefb9227ae66c37fbd6ac9e3f5` |
| `apps/sandbox/src/attempt-exports.ts` | 131 | 0 | `a57f5b50bbe3fcd7fba664801d4aa91e83300988ef72ae57cb486f74975333a8` |
| `apps/sandbox/src/attempt-monitor.ts` | 112 | 0 | `a9ac0253828c2a6784db18a429ca5d3ab4cd1a6093ecd87bc564b23c382bccd7` |
| `apps/sandbox/src/filesystem-authority.ts` | 240 | 0 | `7054ced7be5b9ffc02cc4cc9141563244dec7d2383bde40f111672f861828b33` |
| `apps/sandbox/src/filesystem-journal.ts` | 151 | 0 | `0652b1065a48d858f3364376b090edfc18f2630018c306e01eb029598181e8d0` |
| `apps/sandbox/src/filesystem.ts` | 24 | 0 | `feade9fd1ee6d1b74e7dbe9461e0b1dc86c8d6285884022277207e81ef07f7da` |
| `apps/sandbox/src/immutable-results.ts` | 89 | 0 | `0cd08db54d264c160cbc517680ad6f667ed87bdb7118978056700c7aa35972e1` |
| `apps/sandbox/src/journal-files.ts` | 69 | 0 | `8741c97cee2dc09aae18d9eb66c27139a1473fff191f2154a9e2646ae529b4c0` |
| `packages/loopy/src/contract/sandbox-journal.ts` | 94 | 0 | `0c5366dbe4a2cdd276f1806f9ec3062e1f024a70c2ad7afe1be17ad799b532b5` |
| `packages/loopy/src/contract/sandbox-journal-rpc.ts` | 140 | 0 | `e18ded18a8597638909808ac0528f3a0abb6ee1abdebb4c71fa352616ab5f0b2` |
| `packages/loopy/_tests_/sandbox-authority-contract.test.ts` | 194 | 0 | `e9b75eb0916f7d4099b2e64411ae6d07172f7e4d44d17087fdb91d5f2c07ad18` |
| `packages/loopy/_tests_/sandbox-authority-helper.test.ts` | 71 | 0 | `b6f82f2a471f3d1381cbe46e74da86e1a53c861fcf6779e091ba942352577700` |
| `packages/loopy/_tests_/sandbox-authority-lifecycle.test.ts` | 234 | 0 | `ac7ed1b8e677f002a9fb8221681a65d2bdb00641f73da97e98fe170adc06b2e9` |
| `packages/loopy/_tests_/sandbox-authority-model.test.ts` | 155 | 0 | `1d0f8069d87e8c68d41f81a0453e4e69b403f18cfc12a34bd4674cfa76edb4b7` |
| `packages/loopy/_tests_/sandbox-authority-publication.test.ts` | 167 | 0 | `9b70f4f7c8709619a34f618ab764301811c7032f8c15832bcd7c47591b8aeaa2` |
| `packages/loopy/_tests_/fixtures/sandbox-authority.ts` | 87 | 0 | `8c0c86c428e42235b39c20b6e8624044fc1a49cd8a199524aa442ded23f12821` |
| `packages/loopy/_tests_/fixtures/sandbox-authority-lifecycle.ts` | 31 | 0 | `ed2a114bfcad30a68b8629a897dc725c02f740de3853d4bb843cd7aa4d953cbb` |
| `packages/loopy/_tests_/fixtures/sandbox-authority-model.ts` | 197 | 0 | `a326d83f3827a67e22f04e061a7bb83ccef8d2a3c3c2deafbce109abdf056b39` |
| `apps/sandbox/src/admission.ts` | 2 | 0 | `09dcd93c82b7432359c4aaa2299a535f6711fcd5780f7486e8d059a507e32dcb` |
| `apps/sandbox/src/attempt-reconciliation.ts` | 41 | 0 | `a774feb9b96a8abcd75afc0b43ccf3aa4b76e2e2d1254dedbfbe275e154bd9fa` |
| `packages/loopy/_tests_/sandbox-authority-delayed.test.ts` | 65 | 0 | `f6162014be1815f1f44b6e2e2efb8b8745864fa347586dea3a140d2cda9ed66e` |
| `packages/loopy/_tests_/sandbox-authority-shutdown.test.ts` | 230 | 0 | `1de5c5d4436e686788427d2ef63494abdcf29e783ef548ca8223de894f24f848` |

Total across 30 TypeScript files: **2954 added / 292 deleted**.
