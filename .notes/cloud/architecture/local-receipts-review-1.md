---
title: Independent local execution receipt review, round 1
status: approved within the reviewed scope
date: 2026-10-23
branch: cloud-integration
base: 6ffecdfd60e16aaa335467684d918b3cd8b44813
head: 6ffecdfd60e16aaa335467684d918b3cd8b44813
---

## Verdict

Approve this local receipt refactor. I found no blocking source defect in the reviewed delta. The child claims before effects, duplicate workers cannot execute through an existing claim, saved terminals win, and both parent lookup and the receipt owner preserve a completion published immediately before child death. The current-PID shortcut is valid for the present trusted call sequence. It is not a general concurrent-writer guarantee.

This is a minor refactor under the review skill. It also deliberately strengthens persisted result parsing and identity checks. The wider branch contains independent architecture work; this verdict covers only the local receipt slice and its composition changes. It does not approve the branch for integration or replace the root's remaining gates.

## Scope and pin

Reviewed the entire working delta from the named base for `packages/loopy/src/executor/**`, `packages/loopy/src/local/daemon.ts`, and `packages/loopy/_tests_/executor.test.ts`, plus the two new local receipt test files and their two fixtures. Read `proposal.md`, `fable-review-1.md`, and `local-receipts-implementation.md`. Also inspected the unchanged execution-result contract, protocol, process launch, sandbox and existing executor fixtures/tests where they determine the guarantees below.

HEAD equals base, so there are no intervening commits to review. The candidate consists of uncommitted edits and untracked tests. HEAD tree is `c88beff6f5e91c8a4618f77343c959afcfc90cf2`. The scoped delta adds 606 lines and deletes 81, including 408 lines in the four new test/fixture files. No tests were deleted or moved. The existing executor test changes only the parent-loss caller's explicit receipt injection.

Fresh evidence directory, relative to this checkout:

`.loopy/architecture-tests/local-receipts-review-1-a50ffd29-b17e-452f-9bfc-d7895e1c49a4/`

`before.json` and `after.json` contain SHA-256 hashes for every executor source, daemon composition, shared result schema and selected test/fixture. All 16 pinned files were unchanged between capture and completed verification. The nine lane-owned hashes match the implementation note. Root-owned hashes are:

```text
123b7ad4a6709d18d9f766cd296f8ba5bfd7dc9ba6d8611d706d490b0ef636d9  packages/loopy/src/executor/index.ts
6070916379af4c2368efe6dfd8020441fef38434c8943e114fdae3aef33ed39f  packages/loopy/src/local/daemon.ts
```

The SHA-256 of `tracked-scope.patch` is `c3b8552505e19b836e5768bcfaa70bfe0d2951a91e969155762bd6e8bb724df3`. The sorted compact JSON file-hash map has SHA-256 `797e968220edf727ad6aa2c8783efad92327f645305f494fa150a537d7343984`. The working tree had many unrelated modifications at entry. Those are neither reviewed nor attributed to this slice.

## Findings and evidence qualifications

No P0, P1 or P2 source findings. Two P3 evidence qualifications do not block this implementation.

### P3. The implementation note overstates the candidate's parent-process competition test

Location: `local-receipts-implementation.md:88`, with the test at `packages/loopy/_tests_/local-receipts.test.ts:130-151`.

The note calls this "two competing parent processes". The test calls one `f.executor` twice in the same process. It does launch competing real trusted children and checks the right effect marker and final saved result, but it does not exercise distinct parent PIDs or reconstruction in two parents. The causal impact is overstated evidence, not an observed duplicate effect.

Smallest fix: describe the candidate test as concurrent parent calls with competing trusted children. If retaining the distinct-parent claim, preserve a subprocess test that gates both parents after observing absence and before launching either child, then checks one effect and the authoritative terminal.

Independent evidence in this review closes that scenario for the pinned candidate. `probe.ts` launched two real parent processes, PIDs 49290 and 49291, and held both after their initial absent read. After release there was exactly one appended `once` line, one saved successful terminal with output 42, and one parent returned that success. The other parent returned an unsaved `protocol` failure because its child encountered the existing started claim. That differing caller result is existing `LocalExecutor` behavior at `local.ts:134-145`, not a new regression or agreement guarantee. The probe proves single-effect admission for this interleaving, not identical concurrent caller outcomes.

### P3. The parent-reread mutation proves a call-path assertion, not terminal loss

Location: `packages/loopy/_tests_/local-receipts-recovery.test.ts:45-48,69-74`; implementation note's negative-control row for removing the parent reread.

The test uses a real subprocess and deterministically places publication between the first parent read and its PID probe. Its saved-result assertion is useful. However, removing the outer reread is reported to fail because `finishes` becomes one. In this candidate, `FilesystemReceipts.finish` independently reads the terminal at `receipts.ts:132-135` and returns it. The mutation therefore demonstrates the requested outer call sequence, not that this single mutation loses the saved result. Treating it as independent evidence of terminal corruption would overstate the control.

Smallest fix: label that control as parent call-path coverage. Missing durable assertion: directly force the owner's initial read to return started, let the real child publish and exit, then invoke its foreign-PID completion path and assert that the saved success beats the proposed uncertain result. A control removing the owner's reread must then fail on the saved result, rather than a call counter.

Independent `owner-race.ts` exercises that owner-level interleaving without changing source. It returned the child's saved success after exactly two reads, instead of publishing the parent's proposed uncertainty. `owner-race.log` retains the result. No source mutations or mutation controls were rerun in this review.

## Safety assessment from the callers and code

### Admission and current-PID ownership

`ExecutionWorker.execute` awaits `receipts.claim` at `execution.ts:55` before entering the effect-performing `try`. Only `created` reaches `perform`. Existing finished work returns its result; existing started work throws outside the catch that turns execution errors into terminal failures. This placement matters for same-process workers: a losing worker cannot catch its duplicate-claim rejection and call `finish` under the winner's PID.

`FilesystemReceipts.claim` uses `open(..., "wx", 0o600)`, writes the child PID and identity, syncs the file, closes it and syncs the containing directory before returning `created`. An incomplete claim can make a competitor fail JSON parsing. It never grants execution or becomes absence. The effect-count tests and the independent gated parent probe agree with this source path.

At `receipts.ts:142-163`, equal PID permits publication without another liveness check. That equates process identity with the trusted claimant. It does not authenticate individual objects or async tasks. This is sufficient here because `worker.ts` reconstructs the owner in the child and only the winning `execute` calls `finish`. Production parent lookup does not finish a live current-PID record: its PID-zero probe returns started. Sharing one owner across daemon runs introduces no mutable per-attempt cache. No caller added in this slice violates that sequence.

### Terminals and death races

`finish` returns an already saved terminal without rewriting it. A foreign live PID blocks replacement. Only ESRCH permits proceeding; other probe errors propagate. After ESRCH the owner rereads before publication. `LocalExecutor.lookup` also keeps its original death probe and reread. The candidate's parent race and independent owner race exercise both levels. Killing the trusted worker after an effect marker yields saved `uncertain`; repeating the same attempt returns that terminal without another effect. Killing the caller leaves the trusted child able to finish its receipt.

Rename remains atomic publication, not compare-and-set. The code does not serialize arbitrary concurrent recovery writers after child death, and the current-PID shortcut does not serialize arbitrary simultaneous `finish` calls. PID reuse, out-of-protocol receipt replacement and detached descendants remain explicit limits. Those limitations are already acknowledged by the accepted design and implementation note; this extraction does not introduce a new supported multiwriter mode. Worker death can leave its already launched bundle briefly running, as the kill test itself allows. Uncertainty prevents automatic same-attempt repetition; it does not certify external effects have stopped.

### Binding, parsing and security

The daemon explicitly constructs `FilesystemReceipts(home)` and injects it into every prepared executor through the executor layer entry. `LocalExecutor` checks that its descriptor home equals the protected home, and `worker.ts:48-54` repeats the binding check after parsing the strict filesystem descriptor. Equivalent path spellings are intentionally not normalized by this check. Trusted callers use the same home string.

The parent serializes an explicit request containing descriptor data, never the injected object or bundle resolver. The BigInt sentinel test causally detects accidental instance serialization. The child constructs its own concrete owner. Executable bundle stdin contains only execution input; bundle environments use the existing declared-secret path. Command launch reads the existing execution context and does not serialize the receipt object into command configuration. The descriptor introduces no credential field or authority token. Existing full-command environment inheritance is unchanged, so this is not a claim that all ambient credentials are excluded from full commands.

Independent direct invocations of the actual `worker.ts` rejected both a descriptor bound to the workspace and a descriptor containing an extra synthetic credential field. Both exited one before creating a claim in either proposed home, and neither added an effect. Existing bundle and command denial tests passed in sandbox and full modes. Redaction tests passed for output, logs and saved receipts.

`read` parses persisted bytes and then compares execution key and attempt on every path. Missing files alone return null. Corrupt JSON, foreign identity and schema failures propagate. The shared result schema is stricter than the removed local duplicate: unknown nested result/log/error fields and fractional exit codes are rejected. Normal producer-generated started, successful and failed single-file receipts retain their shape and decode without byte rewriting. The old-format test uses hand-authored representative records, not an actual historical dataset. No copied old-state compatibility claim is made.

Directory encoding and symlink rejection are retained. The code validates directories with `lstat`; it is not a defense against an actor who can arbitrarily mutate the protected home between filesystem operations. That actor is outside the existing sandbox boundary. No new fallback, format, migration or second terminal file was added.

## Verification performed

From `/Users/hatim.shakir/projects/loopy/cloud-integration`:

```sh
bun test --timeout 60000 \
  packages/loopy/_tests_/local-receipts.test.ts \
  packages/loopy/_tests_/local-receipts-recovery.test.ts \
  packages/loopy/_tests_/executor-command.test.ts \
  packages/loopy/_tests_/executor-security.test.ts \
  packages/loopy/_tests_/executor.test.ts \
  -t '^(?!compiled command parser)'
```

Printed `47 pass`, `1 filtered out`, `0 fail`, `332 expect() calls`, five files, 11.04 seconds. Full output is `focused-tests.log`. The service/daemon composition integration test was deliberately filtered out to keep execution within the requested receipt-only, no-services boundary.

From the fresh evidence directory above:

```sh
bun --no-env-file <evidence-directory>/probe.ts
bun --no-env-file <evidence-directory>/owner-race.ts
```

Both exited zero. `probe.log` records the gated real-parent competition and child descriptor rejections. `owner-race.log` records preservation of the child's success through owner-level confirmed-death recovery. All fixtures use new synthetic state. Worktree-local sandbox execution emitted expected EPERM diagnostics for denied ancestor repository/config reads; the effect and terminal assertions passed with enforcement active.

`git diff --check -- packages/loopy/src/executor packages/loopy/src/local/daemon.ts packages/loopy/_tests_/executor.test.ts` exited zero without output. Git status, base/HEAD, reverse-range log, full scoped tracked diff and hashes were inspected. No broad build, lint, typecheck, architecture suite, workload, migration check or provider check was run. The implementation's reported lint, focused TypeScript and six mutation runs remain author-reported evidence. Reading their controls supports exclusivity, saved-terminal retention, identity rejection, descriptor-only serialization and live-worker refusal; the outer-reread qualification is recorded above.

The only authored repository document is this report. Additional writes are confined to the explicitly allowed fresh evidence directory and isolated test fixtures. No implementation source edits, commits, children, running services, Docker/cloud operations or old-state access were performed. Other lanes' transient type errors were not examined or counted against this slice. The root still owns broad validation, repeated workload, independent cross-lane evidence review and final integration.
