---
title: Local filesystem receipt implementation
status: focused validation complete
base: 6ffecdfd60e16aaa335467684d918b3cd8b44813
branch: cloud-integration
date: 2026-10-23
---

## Result and ownership

`FilesystemReceipts` is the concrete local persistence owner. `LocalExecutor` injects it into parent operations and sends only its parsed filesystem descriptor to the trusted child. The child reconstructs its own owner and injects it into `ExecutionWorker`. The existing single receipt file, exclusive child claim, fsync and rename remain.

The accepted proposal and Fable review override the assessment's proposed hard links and second terminal file. Terminal publication relies on the exclusive child and parent liveness protocol. Rename alone does not provide compare-and-set.

Owned edits are the four executor source files, the existing executor parent-loss test, two new local receipt tests, two new fixtures and this note. Root owns `executor/index.ts` and `local/daemon.ts`, including the class export and explicit home-bound injection. Those two files were not edited by this lane. No children, commits, pushes, main changes, cloud operations, shared-service changes or live workload were performed.

## Public signatures

These types are exported by `executor/receipts.ts`. Root controls layer-entry exports.

```ts
type FilesystemReceiptsDescriptor = {
  kind: "filesystem";
  home: string;
};
type LocalReceipt = z.infer<typeof receiptSchema>;
type AttemptIdentity = Pick<LocalReceipt, "executionKey" | "attempt">;
type FinishedLocalReceipt = Extract<LocalReceipt, { kind: "finished" }>;

class FilesystemReceipts {
  constructor(home: string);
  get descriptor(): FilesystemReceiptsDescriptor;
  read(identity: AttemptIdentity): Promise<LocalReceipt | null>;
  claim(identity: AttemptIdentity): Promise<
    | { kind: "created"; receipt?: undefined }
    | { kind: "existing"; receipt: LocalReceipt }
  >;
  finish(value: FinishedLocalReceipt): Promise<FinishedLocalReceipt>;
}

function receiptPath(home: string, key: ExecutionKey, attempt: number): Promise<string>;
```

`filesystemReceiptsDescriptorSchema` is a strict object schema for the descriptor. `receiptSchema` preserves the saved identity plus `started/pid` or `finished/result` union. Its result field now uses the shared `sandboxExecutionResultSchema`.

`LocalExecutor` has this constructor options shape. Its `Executor` methods retain their existing signatures.

```ts
{
  home: string;
  workspace: string;
  mode: ExecutionMode;
  secrets: readonly string[];
  bundlePath: (hash: string) => string;
  receipts?: FilesystemReceipts;
}
```

`ExecutionWorker` takes the same fields with required `receipts: FilesystemReceipts`. `LocalExecutor` defaults the owner from its home for existing direct callers. Parent construction and the parsed trusted-child request reject a receipt descriptor whose home differs from the protected execution home. Equivalent path spellings are not canonicalized for this equality check.

## Semantics

- `claim` creates the existing receipt path with `wx`, records the current child PID, fsyncs the file and directory, and only then returns `created`. An existing claim is read and returned. Only a created claim reaches work. An existing finished receipt returns its saved result; an existing started claim rejects execution.
- `read` validates persisted bytes with the shared result schema and validates execution identity and attempt on every read. Missing files return null. Corrupt or foreign receipts throw. Worker reads and parent rereads now get the same identity validation as the original parent lookup.
- `finish` refuses unclaimed work, returns an existing terminal result without rewriting it, and refuses to replace another living worker's claim. For a foreign PID it requires ESRCH and another read before publication. Child publication keeps the fsynced temporary file, rename and directory fsync.
- Parent lookup retains the explicit PID-zero probe, ESRCH-only death rule and reread before terminal uncertainty. A completion published between the initial read and confirmed death wins. Worker death remains `uncertain`, and repeating the same attempt returns that saved failure without another effect.
- `lookupFile`, `startReceipt` and `finishReceipt` were deleted. Persistence callers now use the concrete owner. `receiptPath` remains a shared path helper used by retained tests and the owner, with the same encoded hierarchy and directory symlink checks.
- The shared result schema is stricter than the deleted local duplicate. It rejects extra fields inside result/log/error objects and fractional exit codes. Existing producer-generated saved success and failure formats remain readable without rewriting. Unknown legacy extensions are not silently stripped.
- The worker request explicitly lists serializable fields. It never serializes the injected instance or bundle resolver. Bundle stdin remains the execution input; receipt objects and descriptors stay in trusted composition. Existing secret injection, redaction, protected-home and sandbox behavior remain covered.

There is no new interface, plugin registry, cloud adapter, local-to-cloud migration, run-store schema change, hard link or second terminal file.

## Validation

Final focused suite:

```sh
bun test --timeout 60000 \
  packages/loopy/_tests_/executor.test.ts \
  packages/loopy/_tests_/executor-command.test.ts \
  packages/loopy/_tests_/executor-security.test.ts \
  packages/loopy/_tests_/local-receipts.test.ts \
  packages/loopy/_tests_/local-receipts-recovery.test.ts \
  packages/loopy/_tests_/architecture.test.ts \
  packages/loopy/_tests_/parsed-executions.test.ts
```

Printed `52 pass`, `0 fail`, `348 expect() calls`, seven files, 12.91 seconds. This includes actual parent loss with explicit receipt injection, child death, concurrent parent calls with competing trusted children, same-process worker competition, saved-format reads, corrupt/foreign records, private modes, directory symlinks, descriptor-only serialization, bundle/command receipt denial, redaction, parsed commands and layer boundaries. Ten new receipt tests run under the repo test command's existing `_tests_` discovery path. No tests were deleted or moved. The existing parent-loss test now explicitly injects the owner.

A real subprocess race test releases child publication after the parent's first started read, waits for child exit, then permits the parent PID probe. It asserts the saved completion and zero parent finish attempts.

For the following file set, `bunx biome check` printed `Checked 9 files ... No fixes applied`; `bunx eslint` exited zero without output:

```text
packages/loopy/src/executor/{execution,local,receipts,worker}.ts
packages/loopy/_tests_/executor.test.ts
packages/loopy/_tests_/local-receipts.test.ts
packages/loopy/_tests_/local-receipts-recovery.test.ts
packages/loopy/_tests_/fixtures/local-receipts.ts
packages/loopy/_tests_/fixtures/local-receipts-child.ts
```

Focused TypeScript check used the root compiler options with executor sources and these test roots, without scanning unrelated roots:

```sh
bun -e 'import ts from "typescript"; const config = ts.readConfigFile("tsconfig.json", ts.sys.readFile); const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, process.cwd()); const rootNames = [...ts.sys.readDirectory("packages/loopy/src/executor", [".ts"]), "packages/loopy/_tests_/executor.test.ts", "packages/loopy/_tests_/executor-command.test.ts", "packages/loopy/_tests_/executor-security.test.ts", "packages/loopy/_tests_/local-receipts.test.ts", "packages/loopy/_tests_/local-receipts-recovery.test.ts", "packages/loopy/_tests_/fixtures/local-receipts-child.ts"]; const program = ts.createProgram({rootNames, options: parsed.options}); const diagnostics = ts.getPreEmitDiagnostics(program); if (diagnostics.length) { console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {getCanonicalFileName: p => p, getCurrentDirectory: ts.sys.getCurrentDirectory, getNewLine: () => "\n"})); process.exit(1); } console.log("Focused executor TypeScript check passed.");'
```

Printed `Focused executor TypeScript check passed.` Earlier checks caught a new fixture literal widening and spacing lint errors, fixed here. A temporary service-lane API mismatch was reported during concurrent work and was absent in the final focused check. `git diff --check` on owned tracked files exited zero. No broad fullcheck was run.

## Negative controls

Each mutation was applied alone, the named test failed with exit one, then the original source was restored byte-for-byte before the final validation.

| Mutation | Selected test and observed failure |
| --- | --- |
| Change exclusive claim open from `wx` to `w` | `filesystem claims`, duplicate claim returned created instead of existing |
| Replace retained terminal with a new publication | `filesystem claims`, replacement result differed from saved terminal |
| Remove receipt identity comparison | `receipt reads reject`, lookup did not reject a foreign identity |
| Serialize the injected object instead of its descriptor | `trusted child receives`, JSON.stringify rejected the instance's BigInt property |
| Skip foreign-PID liveness guard in finish | `a live trusted child`, finish did not reject replacement of live work |
| Remove parent reread after ESRCH | parent call-path coverage: one finish attempt instead of zero; the owner has a second reread, so this control alone does not prove terminal loss |

Selections used `bun test --timeout 60000 <local receipt test file> -t <selection>`; the recovery control ran its one-test file without a selection. All six controls failed causally, and the restored final suite passed.

## State and limits

New fixture roots are unique `.loopy/architecture-tests/local-receipts-<uuid>` directories in this worktree and remove only their own roots. The new tests initially used the old executor temporary-directory fixture, then moved to this boundary before final validation. Existing executor tests retain their existing temporary fixtures. The production sandbox still stages bundles through its existing OS temporary-directory mechanism. No existing `.loopy/cloud`, `.loopy/playground` or `.loopy/playground-daemon` state was read, changed or restarted.

An open-but-not-yet-written claim can expose incomplete JSON to a competing read. It fails closed and never becomes absence or permission to repeat work. The new kill test waits for an actual effect marker, which occurs after the claim fsync, before reading and killing. No polling retry or corruption fallback was added to production.

Worktree-local sandbox fixtures can capture Bun warnings for denied ancestor repository/config reads. The sandbox stays enforced and outputs succeed. New execution tests assert the terminal output and durable identity without assuming an empty stderr log.

PID reuse, arbitrary detached descendants and arbitrary concurrent terminal writers remain outside this protocol. Concurrent callers do not gain general filesystem transactions from rename. The test that kills the trusted worker allows its bounded bundle to exit before fixture cleanup. File/directory fsync calls are exercised, but process-kill tests do not prove physical power-loss durability. No remote filesystem, Docker authority, cloud execution, live workload or final integration proof is claimed. Root owns those remaining gates.

## Diff and hashes

Owned code and tests add 601 lines and delete 80 relative to the starting commit. That is 193 added and 80 deleted in tracked files, plus 408 lines in four new test/fixture files. This note is counted separately. Existing `executor.test.ts` was already larger than 250 lines; it changes one line. New test files are 237 and 79 lines; fixtures are 61 and 31 lines. The receipt owner is 183 lines, and all owned executor source files stay below 250.

SHA-256 after final validation, excluding root-owned exports/composition and this note:

```text
84509a36b5b6d7009b1e1bd6c569c166416f0cb01827c25acccd04560cb12ec0  packages/loopy/src/executor/execution.ts
9c9e5f20cdc7297b6c0e79c81b7c72a9816a3fdd0885ab2f0fcccf66f6b97126  packages/loopy/src/executor/local.ts
467aaf71f1a1f12a4d7c505de053c7e546c4a5fd1675ed1d3ec7b3e8a283532f  packages/loopy/src/executor/receipts.ts
4704362b340f8875992f90a28bda6d645b1a9c022075558e7a21d91d125072dc  packages/loopy/src/executor/worker.ts
2cac2768f6799f7069d647a09afaedfcbd289c2d70f949e15b4b082161ca56f8  packages/loopy/_tests_/executor.test.ts
6f469807e09873174751a166c606790656e69b219883fd48026b64a4ff6a61da  packages/loopy/_tests_/local-receipts.test.ts
133f8950172b0808f790c94cda5a851001467378d0afdca1857c4b643fae7936  packages/loopy/_tests_/local-receipts-recovery.test.ts
bfe33408d09ce98328a0b04e475c071d110f7d73938f7c277506186d197f4e59  packages/loopy/_tests_/fixtures/local-receipts.ts
9b995b3bca20fb826e90134875afa48bef757587b533cf9f957f3c25a4a337f4  packages/loopy/_tests_/fixtures/local-receipts-child.ts
```

Independent review qualifications: `local-receipts-review-1.md` adds separate two-parent and owner-level death-race probes. The original concurrent-call test was not a two-parent-process test. Source hashes and original test outcomes above are unchanged; only their interpretation is corrected here.
