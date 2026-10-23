---
title: Independent round-2 review of the architecture workload harness
slug: loopy-architecture-harness-review-2
kind: review
status: approved-with-root-acceptance-gates
date: 2026-10-23
base: 6ffecdfd60e16aaa335467684d918b3cd8b44813
---

# Verdict

Approve the reviewed harness source. All three P2 findings in harness-review-1.md are resolved. No new actionable source defect was found in the correction delta. This approval does not establish workload or live service acceptance.

The change remains a minor tooling feature supporting the execution authority feature. This round reviews the expressly combined fixes, the architecture image selection and the package test command. It does not reopen unchanged architecture or the other implementation lanes.

# Scope and source pin

Reviewed `/Users/hatim.shakir/projects/loopy/cloud-integration`, branch `cloud-integration`, HEAD `6ffecdfd60e16aaa335467684d918b3cd8b44813`, committed tree `c88beff6f5e91c8a4618f77343c959afcfc90cf2`, plus the dirty harness candidate. HEAD alone does not identify that candidate. The reverse commit log against the supplied base is empty because base and HEAD are identical.

Read AGENTS.md, unslop, pr-review, TypeScript guidance and its TypeScript/test references, proposal.md, fable-review-1.md, harness-review-1.md, harness-fixes-1.md and workload-profile.md. The fixes supplement supersedes the old note's weaker baseline description, bare supervisor command and image choice.

I independently recomputed all 65 entries in harness-fixes-1-checks.json. Every source hash matches. The whole-harness aggregate is:

`e3b426b75e1d57f1a98dcfdd8599fe8438940a3b70d6013eab3d54a8ab66d7f4`

The aggregate hashes sorted UTF-8 records `relativePath + NUL + fileSha256 + newline`. Its membership is the 65 entries in the check receipt. Package.json is pinned separately below.

The current check receipt's byte SHA-256 is `805c012f68056ce890fc09cfe60c70af3afbd6036687d34dc352d2f6f27c8114`. This is the actual JSON after root's reported formatting correction. Its recorded source hashes still match. Root reported that integrated check 2 stopped on JSON formatting and check 3 was running. Neither is claimed as this review's completed validation.

Compared with round 1's hash list, 17 harness paths changed or were added. Package.json is the additional integration change. Across the complete 65-file harness plus package.json, comparison with HEAD gives 40 changed/new files, 1,884 added lines and 324 deleted lines. These totals use Python SequenceMatcher with autojunk disabled and count new files as additions. They describe the complete tooling candidate, not only the correction round. The author's narrower correction receipt records 709 added and 97 deleted lines against its intermediate snapshot; I verified its resulting hashes, not that unavailable before-snapshot.

All 47 playground fixture files still match HEAD byte for byte. Their sorted relative-path, NUL and raw-byte SHA-256 remains `a543c987ac688368fe998d5d23e2ae6f219a1717974e3df705c2b548486bb404`.

# Disposition of the original findings

## Finding 1 resolved. Stop verifies the selected launch before signalling

Inspected `stack.ts`, `stack-identity.ts`, `supervisor.ts`, the CLI forwarding and their tests.

Each start generates a UUID nonce and passes explicit profile, state root and nonce flags. Serve validates those flags against the selected profile before process observation, port checks or initialization. Its version-2 manifest stores the launch identity, positive owner and group IDs, and complete expected argv.

Actual stop parses that manifest, observes the owner, then calls requireOwnedSupervisor before signalGroup. The guard at `scripts/playground/stack-identity.ts:94` requires the selected root/state/profile, group leadership, observed PID/PGID, exact command and canonical argv. The command includes the per-launch nonce. Old manifests and an absent or mismatched process cannot authorize a signal.

The focused tests invoke actual stop with injected process observations and an inert signal callback. They confirm one request for the matching group and zero requests for legacy commands, another profile/state/root, a later same-profile nonce, absent processes, PID/PGID mismatches, invalid owners, old manifests and altered argv. Serve identity parsing also rejects missing or mismatched flags.

The tests' printed SIGTERM sentence comes from the real stop function after the injected callback. No OS signal or real process observation occurred. Real ps command rendering and the owned launch/stop lifecycle remain root checks. Observation followed by signalling is a process snapshot, not an atomic kernel handle.

## Finding 2 resolved. Arm requires a usable current-batch baseline

Inspected `baseline.ts`, `prepare.ts`, `metrics-statistics.ts`, `metrics-segments.ts`, the sampler producer and their tests.

Sample now derives from the shared sampleSchema in metrics-statistics. Segment analysis imports that same schema. requireCurrentBaseline validates capture metadata, actual sample shapes, current batch and canonical evidence-directory membership. It accepts baseline-small and the documented baseline alias.

The coverage filter at `scripts/playground/baseline.ts:49` requires a valid timestamp, no failure, 2xx status, positive bytes and present nonnegative timings. All 14 unconditional endpoint names must have a successful sample. Failed observations remain in the returned samples and the raw capture.

Actual arm tests demonstrate no new gate for null/malformed samples, empty or all-failed captures, non-baseline phases, wrong batch, outside-directory evidence, a missing preflight and each independently omitted endpoint. Incomplete timing, zero bytes, HTTP failure and unsuccessful observations do not satisfy coverage. A producer-generated usable baseline plus three passing preflights writes the disposable gate. The alias passes too.

Conditional run-detail endpoints stay outside the initial gate. Their real workload coverage remains a root obligation.

## Finding 3 resolved. The collector derives inventory authority from journal identities

Inspected `receipt-inventory.ts`, admissionSchema, the inventory producer and actual collector call order.

The boundary requires exactly 528 terminal run rows and 528 unique current-batch IDs. It independently loads primary and preflight admission files. It rejects null run IDs or admission acknowledgements, foreign batches, duplicate IDs across either phase and inventory/status mismatches. It derives exactly 525 primary admissions with 461 expected successes and three successful preflights. The combined 528 distinct admitted IDs must therefore equal the 528-row inventory set. Literal summary count fields no longer establish any prerequisite.

The actual collector calls receiptInventory at `scripts/playground/verify-receipts.ts:23`, before constructing the authority. The original one-row/literal-528 exploit now fails at that boundary.

I ran the actual collector entry point in nine independent synthetic scenarios. Eight invalid cases, one row with literal summary counts, duplicate inventory row, missing primary journal, missing preflight journal, null admission ID, duplicate admission ID, foreign admission batch and expected-status mismatch, each rejected with zero authority constructions, zero receipt/result reads and no passed output.

The valid scenario supplied 528 terminal IDs, all 528 admission files and three synthetic completed backend identities. It passed with runCount 528 and three verified receipts. The real receiptEvidence path resolved canonical result bytes and retained their SHA-256, size and execution identities. Output omitted the admitting session nonce while retaining sessionEpoch. Three receipt/result pairs produced a minimum observed receipt-read interval of 100.07025 ms. All nine scenarios made zero network calls.

This bounded success case checks the collector's entry path, not full workload coverage. Exact enumeration of every authority identity still requires the stopped SQL copy. The collector's stated limit remains accurate.

# Other correction changes

Architecture selects `loopy-sandbox:architecture-bun-1.4.0`; the unset profile retains `loopy-sandbox:bun-1.4.0`. Config consumes the profile selection. The assertion covers both tags. This review built neither image.

Package.json now includes `scripts/playground/_tests_` in the root test command. I inspected that wiring and ran that folder directly. I did not run the root test command or full check.

The old weak baseline helper test in profile.test.ts was replaced by actual-arm coverage in baseline-gate.test.ts with baseline-fixture.ts. Stack identity and inventory tests were added. No test was deleted or moved by this reviewer. The author's eight disposable mutation controls were read as context, not rerun or counted as independently executed evidence.

# Verification record

All commands below exited zero. Scratch root was `.loopy/architecture-tests/harness-review-2-wdo3bxtd`. Test temp files used its tmp directory. The inventory test also created and removed its own fresh directory directly beneath .loopy/architecture-tests.

1. `TMPDIR="$PWD/.loopy/architecture-tests/harness-review-2-wdo3bxtd/tmp" bun --no-env-file test scripts/playground/_tests_` printed 19 pass, 0 fail, 184 expect() calls across six files.
2. `TMPDIR="$PWD/.loopy/architecture-tests/harness-review-2-wdo3bxtd/tmp" LOOPY_PLAYGROUND_PROFILE=architecture bun --no-env-file test scripts/playground/_tests_` printed the same 19 pass, 0 fail and 184 assertions.
3. `bun x --no-install tsc --noEmit -p scripts/playground/tsconfig.json` produced no output.
4. `git diff --check -- scripts/playground scripts/daemon-playground package.json` produced no output.
5. The following focused formatter check printed `Checked 21 files. No fixes applied.`:

```sh
bun x --no-install biome check scripts/playground/stack.ts scripts/playground/stack-identity.ts scripts/playground/supervisor.ts scripts/playground/index.ts scripts/playground/baseline.ts scripts/playground/prepare.ts scripts/playground/metrics-statistics.ts scripts/playground/metrics-segments.ts scripts/playground/profile.ts scripts/playground/config.ts scripts/playground/receipt-inventory.ts scripts/playground/verify-receipts.ts scripts/playground/_tests_ package.json .notes/cloud/architecture/harness-fixes-1-checks.json
```

6. The following focused ESLint check produced no output:

```sh
bun x --no-install eslint scripts/playground/stack.ts scripts/playground/stack-identity.ts scripts/playground/supervisor.ts scripts/playground/index.ts scripts/playground/baseline.ts scripts/playground/prepare.ts scripts/playground/metrics-statistics.ts scripts/playground/metrics-segments.ts scripts/playground/profile.ts scripts/playground/config.ts scripts/playground/receipt-inventory.ts scripts/playground/verify-receipts.ts scripts/playground/_tests_
```

7. Ran `bun --no-env-file .loopy/architecture-tests/harness-review-2-wdo3bxtd/collector-probe.ts <scenario>` separately for each of `valid`, `one-row`, `duplicate-row`, `missing-primary`, `missing-preflight`, `null-id`, `duplicate-admission`, `foreign-admission` and `status-mismatch`. The valid case printed passed, runCount 528, constructors 1, reads 3, gets 3, nonceOmitted true and hashBytesIdentityRetained true. Each invalid case printed rejected true, constructors/reads/gets 0 and passedOutputAbsent true. Every case printed networkCalls 0.

The retained probe's SHA-256 is `bdb73fb3774a1dd36f9635da972d3b1e79fdc9eccc9be8dd9b25015d7db5737d`. It substitutes only isolated configuration and the authority class for the collector run. A global fetch guard rejects any attempted network use. Production inventory parsing, collector logic, receiptEvidence and result hashing execute unchanged. All fixture reads and writes are inside this fresh scratch root.

Read-only Python pin checks independently verified every source-manifest entry, recomputed the aggregate and current JSON/package hashes, compared all 47 fixture bytes with `git show 6ffecdfd60e16aaa335467684d918b3cd8b44813:<path>`, and calculated the complete tooling line delta. `git rev-parse HEAD HEAD^{tree}` returned the hashes above. `git log --oneline --reverse HEAD...6ffecdfd60e16aaa335467684d918b3cd8b44813` printed nothing.

# Root acceptance gates

These are remaining workload/integration obligations, not new source findings.

1. Finish the root-owned full check against the final source pin and converge the other review lanes. The running check reported by root is not a completed result in this report.
2. Build the separate architecture image after source stabilization and record its exact digest. At launch verify reserved ports, actual argv/nonce/PID/PGID rendering, owned child readiness and stop behavior. Preserve old state and protected services.
3. Capture baseline-empty for diagnostics if desired, then source preparation and three preflights, then a usable baseline-small before arm. Complete 525 primary cloud runs with 461 successes, 64 controlled failures and 125 approvals, plus the three preflights. Establish 528 unique terminal IDs. Complete the 45 daemon runs with 39 successes, six controlled failures and nine approvals.
4. Retain the full endpoint, continuous, matched and postload measurements. Record sampler completion times before running the read-only collector so its traffic is excluded from performance windows. The collector does not enforce that ordering.
5. Run the collector against actual completed backend identities while the selected authority remains available. Then stop the owned authority, take an approved closed copy and compare its complete exact identity set with the runtime journal, including terminal pointers and immutable result references. Count equality alone does not establish set equality. Enumerate unexpected authority records separately; the online collector cannot discover them or unreferenced R2 blobs.
6. Supply pinned real local workerd/DO/R2 and Docker acceptance for lost acknowledgement with unavailable resolving reads, session fencing, restart without replay, terminal publication, transport ambiguity, worker loss, timeout, export guards and shutdown. Record authority/result calls, R2 reads and write amplification.
7. Complete closed-copy SQL/read-model acceptance, browser acceptance and final integration under root's existing scope. No live database, browser, main checkout or integration action was used here.

# Correction source hashes

The 17 paths below differ from round 1 or are new. Package.json is included separately. Unchanged dependencies are covered by the verified 65-entry receipt and aggregate above.

```text
1dc4b279dcac85b8c6a140279f3513d0fd1170a7861d552280379d7373aa0239  scripts/playground/_tests_/baseline-fixture.ts
10fe9430a7418eeca939ae87157406f2363f94faf6999f86bef2a68a3be91ff3  scripts/playground/_tests_/baseline-gate.test.ts
82d2343c6e574af7477231503fb4f4cd4d9f0edb3af31bb597fe75cad7a6a1fe  scripts/playground/_tests_/profile.test.ts
d8bd36cd5e87c3c3b8cc24a8f67374adde4d457a06b0d87bb916948820039b90  scripts/playground/_tests_/receipt-inventory.test.ts
97fcc76dbddf7eb624492ef27fc6401138fd99c40fb9e70d002d7c2e12003cf4  scripts/playground/_tests_/stack-identity.test.ts
bec431ec1ee849f55c0b3a0a10fc32934546812bda718519f0e6d766be045487  scripts/playground/baseline.ts
0c4581ac49ea8217f739bc228d9cd137c9a46203b0b73c3a160635f41573ab98  scripts/playground/config.ts
e6c7de53ba24934aa447822cd39bbdccbf0d3ccc39e5c5b5e48209cd949b98f5  scripts/playground/index.ts
e4ee410930f59bc8d8d709f44c1c1940bab0d7bcf0928ab305f1490ddb939fef  scripts/playground/metrics-segments.ts
768ad51b7cf2ad4a4138521f8584f05f6c49481e10b760710dd155207029651e  scripts/playground/metrics-statistics.ts
07a50bcaf1212bb5d1d70652d271b99309803bce6745e51978ffd61fdedd2b8b  scripts/playground/prepare.ts
7dbd4fb14dac25a04a2fb29e1818bad69e158a811366a6d21e23fe594adf6712  scripts/playground/profile.ts
bdba5f3fc3c31471dfaaeee1a0b5f0d2c7c69e53bf047190361050bd79d4d0a4  scripts/playground/receipt-inventory.ts
882e6302235e50497f05329af2a39bec9e04a452d670dda17086022499b11794  scripts/playground/stack-identity.ts
d96009b9295cc38b096a3d0d4e8c6df2d555ffebdc04786ac8a045cf84c22607  scripts/playground/stack.ts
2703c1dd00900e3a6320ee7f571f0eec6a04dbc56caadd0486ee5147ccc51d7f  scripts/playground/supervisor.ts
51e8cc13a79c99ab9179638d46b7448a5d057dbd4d56e3c9e847fe2914030537  scripts/playground/verify-receipts.ts
b0cedd4c2b9f6ac2b951e8243c287d347ec1028dc43eb7f24ee1b146d3c087da  package.json
```

This report is the only repository artifact authored by this reviewer. Synthetic probe files remain only under the fresh .loopy/architecture-tests scratch root. No production source, existing test or machine receipt was edited. No prior state/private credentials, real port checks, services, Docker commands, live APIs, full check, commits, delegates or main-checkout operations were used.
