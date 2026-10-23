---
title: Local Docker and durable receipt proof
status: seven bounded scenarios passed, independent cleanup verified, massload gated
date: 2026-10-23
base: 6ffecdfd60e16aaa335467684d918b3cd8b44813
---

The separately authorized fresh invocation passed all seven scenarios after the fixture-only proxy correction. It used five attempt identities and four sequential Docker workers, actual Miniflare/workerd SQLite DO authority and local R2. Independent post-checks verified cleanup and maximum worker concurrency one. The earlier invocation failed before admission and remains preserved as failed evidence. No image build, cloud operation, commit, broad check, global TMPDIR override or shared-service action was performed by this lane. Massload remains gated.

Read AGENTS, unslop, TypeScript craft, worktree guidance, proposal, Fable review 1, both sandbox/durable implementation notes and sandbox review 1. Root subsequently reported that review 2 approved the shutdown correction and supplied a newly built image. That report is a launch prerequisite supplied by root, not an independently repeated review here.

## Launch plan

One invocation runs four sequential Docker workers with five authoritative attempt identities. Worker concurrency is at most one, below the authorized ceiling of two. The fifth admission must never start. Each worker has an eight-second bridge deadline and a sixty-second in-container code timeout, so the deadline case exercises the bridge's actual Docker kill. Expected wall time is 45–90 seconds. Scenario execution has a 100-second deadline, individual Docker commands have finite deadlines, and the whole invocation has a 180-second deadline. A hard overall timeout is a failed run and requires checking the recorded owned resource names before retrying. It does not establish successful cleanup.

The entrypoint requires the explicit gate and an architecture image tag plus full SHA-256. It has no default image and never builds, pulls, retags or removes images. Root supplied this image and its build log `.loopy/architecture-tests/image-build.log`:

```text
loopy-sandbox:architecture-bun-1.4.0
sha256:ffc247b1e3a93dc0eafb8f387ed52d5b8fc7445e929a701f2117f6a0cc175722
```

After root explicitly opens the gate, run exactly once from the cloud-integration checkout:

```sh
LOOPY_ARCHITECTURE_DOCKER_GATE=root-runtime-stable \
LOOPY_ARCHITECTURE_DOCKER_IMAGE=loopy-sandbox:architecture-bun-1.4.0 \
LOOPY_ARCHITECTURE_DOCKER_IMAGE_ID=sha256:ffc247b1e3a93dc0eafb8f387ed52d5b8fc7445e929a701f2117f6a0cc175722 \
bun --no-env-file packages/loopy/_tests_/fixtures/architecture-docker-proof.ts
```

The image preflight uses only `docker --context colima-loopy-cloud-phase1 image inspect --format '{{.Id}}' <exact-tag>`. It must match the supplied hash before any worker creation. The historical `loopy-sandbox:bun-1.4.0` image is never selected. Image provenance relies on root's build record and supplied hash, rather than claiming a binary/source equivalence test.

## Assertions

| Sequence | Actual mechanism and expected observation |
| --- | --- |
| 1. Duplicate admission | Two authenticated HTTP POSTs share one identity. Production `Attempts` with `DockerBackend` starts one worker. Worker A writes `A\n` into its private run volume and returns success. Repeated POST preserves success and start count. Changed content returns 409. |
| 2. Authenticated export and retained guard | Missing credentials return 401, traversal returns 400 and a different workspace returns 404. Actual `DockerArtifacts` creates and executes the exact labelled helper. A command-runner fault throws before helper removal, retaining a real stopped helper and a persisted SQL guard. Export returns 409. Same-volume admission is denied with no backend start. |
| 3. Full durable reconstruction | Close the production bridge, dispose actual Miniflare/workerd, then reconstruct both over the same isolated SQLite/R2 directories. Worker A's complete record, admitting session, plan, result reference and bytes must remain identical. Repeated admission leaves the same Docker container ID and StartedAt. The retained guard/helper still deny admission while cleanup remains injected unavailable. |
| 4. Lost acknowledgement and same-session first start | Restore actual helper cleanup. The next same-volume admission reconciles the old guard, removes the exact helper and confirms absence. A real loopback proxy forwards admission to the production Worker/SQLite DO, consumes its successful committed reply, then substitutes HTTP 503. Three resolving HTTP reads also return injected 503. Two concurrent identical POSTs eventually produce exactly one worker B start and success. Actual artifact export returns exactly `A\nB\n`, with no extra execution marker. No guard/helper remains. |
| 5. Actual killed worker | Admit worker C, inspect the exact owned container until Running, then execute actual Docker kill. The terminal result must be `uncertain`. Repeated admission cannot start it again; its Docker ID and StartedAt remain unchanged. |
| 6. Actual deadline | Admit worker D and observe Running. The production backend reaches its eight-second deadline, performs actual Docker kill and confirms it stopped. Assert the exact execution timeout result and one start even after a repeated POST. |
| 7. Shutdown during read outage | Commit the fifth admission, replace its acknowledgement with 503, and keep resolving reads unavailable. Wait until a resolving read has actually failed before invoking production `startSandbox.close()`. The call must finish within three seconds with its outstanding HTTP handler settled, lock absent and zero backend starts. A successor session uses the actual Docker recovery path to finish the absent worker as uncertain, still with zero starts. |

Steps 2 and 4 inject faults at the real Docker command boundary and real authority HTTP proxy respectively. They do not simulate Docker daemon failure, TCP packet loss or bridge process death. Step 3 uses full graceful runtime destruction/reconstruction. Step 5 kills an actual container process. The shutdown admission uses the accepted production public server close method, with an emergency attempts-close path only to drain this fixture if that wrapper regresses. A regression remains a failed assertion.

The DO is the production `SandboxReceipts` class in the bundled production Worker. Miniflare uses actual workerd SQLite Durable Objects and local R2 bindings. `HttpSandboxAuthority` supplies both the authority and workspace-bound immutable results through production `startSandbox` dependency injection. All bridge, proxy and workerd listeners use fresh loopback port zero. Credentials are fixed synthetic strings created in this fixture, distinct for bridge, principal and sandbox HTTP access. No personal secrets or previous datasets are consulted.

## Resource ownership and stop procedure

Every invocation creates a fresh `.loopy/architecture-tests/docker-durable-<unique>` directory. Its nested `.loopy/cloud/sandbox` root satisfies production root validation. Worker names, input volumes and run volumes derive from that fresh absolute root and complete attempt identity. No host path is mounted into Docker. The worker has the production restricted root, UID, network-none, memory, CPU and PID limits.

The fixture records its exact resource plans before each backend start/recover in `resource-identities.json`. It never uses daemon-wide prune, kill, stop or removal operations. Normal shutdown closes the current production bridge, aborts admissions, drains monitors and artifact operations and releases the owned root lock. Cleanup then visits only these exact receipt-derived names:

```text
loopy-attempt-<owned-attempt-id>
loopy-attempt-<owned-attempt-id>-input
loopy-artifact-<owned-attempt-id>
loopy-input-<owned-attempt-id>
loopy-workspace-<owned-root/workspace/run-hash>
```

Before removal, container inspection must match the root's SHA-256 owner label and the exact admitted request hash. Artifact helpers must also carry `loopy.sandbox.role=artifact`. After removal, an exact-name filtered listing must show absence. Input/run volumes use their fresh root-derived exact names; production creates them without labels. Cleanup refuses to remove a volume with any remaining attached container. It removes only those enumerated exact volumes and checks absence. Finally the proxy and workerd runtime stop. Local SQL/R2 persistence and evidence remain for review. No old test directory is removed.

On an overall timeout or failed cleanup, root must use this invocation's printed root and `resource-identities.json`, inspect those exact identities/labels, and finish that same narrow cleanup before authorizing another run. There is no automatic second invocation or ambiguous admission retry.

## Evidence produced after an authorized run

The fresh directory will retain `report.json`, `source-before.json`, `source-after.json`, `worker-bundle.json`, `authority-events.json`, `docker-commands.json`, `resource-identities.json`, `storage-files.json`, bundled Worker code and actual local SQL/R2 persistence. The final report records timestamps, image tag/hash, worker count, source drift and cleanup errors. Docker command records include execution output, identity inspections and exact removal/absence checks. Authority events retain actual typed requests/replies, fault counts, durable plans, result refs and asserted artifacts.

Source inventories include sandbox/cloud/package source and test fixtures. The bundled Worker is hashed. Receipt-stack drift fails acceptance. Concurrent unrelated host/read-model changes are recorded separately and do not fail this isolated proof. This run will prove local durable storage and process behavior for these scenarios. It will not prove remote Cloudflare replication, power-loss guarantees, fencing against arbitrary delayed Docker commands or exactly-once external effects. It does not replace the later 525-run workload or main integration gates.

## Offline preparation checks

These commands were run narrowly on the four new fixture files, with no production edits:

```sh
bunx biome check --write packages/loopy/_tests_/fixtures/architecture-docker-*.ts
bunx eslint --fix packages/loopy/_tests_/fixtures/architecture-docker-*.ts
bunx tsc --noEmit --target ES2022 --lib ES2022,DOM,DOM.Iterable --module ESNext --moduleResolution Bundler --strict --noUncheckedIndexedAccess --skipLibCheck --types bun-types packages/loopy/_tests_/fixtures/architecture-docker-*.ts
env -u LOOPY_ARCHITECTURE_DOCKER_GATE -u LOOPY_ARCHITECTURE_DOCKER_IMAGE -u LOOPY_ARCHITECTURE_DOCKER_IMAGE_ID bun --no-env-file packages/loopy/_tests_/fixtures/architecture-docker-proof.ts
```

The first three passed after preparation fixes. The last deliberately exited 1 with Zod errors for the missing gate/image/hash. No existing tests were deleted or moved. No optional test wrapper was added, so ordinary `bun test` cannot accidentally opt into Docker. No full repository check was run, as instructed. This note will receive actual outcomes only after the explicit root launch gate and bounded run.

## Authorized invocation result

Root explicitly opened the gate for one invocation. The exact prepared command exited 1 after about 0.48 seconds, including runtime setup. The recorded scenario interval was `2026-10-23T15:01:06.242Z` through `2026-10-23T15:01:06.402Z`. Evidence is retained in `.loopy/architecture-tests/docker-durable-BrvpjY/`. The Worker bundle SHA-256 is `5e9aedbbea0eb41e804d1a2472fad74cc152f6aff8fe4651082794b7b0294072`.

Image preflight matched the exact supplied architecture image hash. Actual Miniflare/workerd started on loopback port 63289 and the fixture proxy used port 63290. The sole authority operation was `status`, which returned HTTP 200 and decoded bytes `{"epoch":0}` upstream. Reading the rebuilt response through `HttpSandboxAuthority` failed with `TypeError: ZlibError`. No session opened, no admit occurred, no backend start/recover ran, and no worker/helper/volume creation command occurred. All seven intended scenarios remain unproved by this invocation. There was no rerun or additional attempt identity admitted.

This was a fixture transport failure, initially diagnosed at `architecture-docker-runtime.ts` where the proxy reads `response.arrayBuffer()` and forwards those decoded bytes alongside unchanged upstream headers. An inherited compression header can make the next Bun fetch try to decompress plain JSON. The retained upstream bytes and the client ZlibError supported this explanation, but that invocation did not log upstream headers. The correction was initially held for root, then authorized and locally verified as recorded below. No production defect is established by this failure.

The fixture's cleanup completed with zero errors and retained empty `plans` and `starts` arrays. A separate read-only post-check ran after process exit, independent of the fixture cleanup function. It checked container absence using only this root's exact owner label, checked all nine exact possible input/run volume names for the five prepared identities, checked that `service.lock` was absent, and used `lsof` to verify neither allocated port had a listener. Every check passed. No cleanup mutation was necessary. Its raw command results and timestamp are in `independent-postcheck.json`.

The owner label was `cd21ddc49802f5d04798dd3fc46f31c34a74d781ee10be8ab78dc5f32dc9dd30`. The root, bundle, before/after source hashes, SQL/R2 file inventory, authority events, Docker command log, error stack and independent post-check remain available. The observed source drift was only `apps/cloud/src/artifacts-definitions.ts`, during root's announced concurrent summary work. `changedCriticalSources` is empty. This unrelated drift did not cause the fixture failure or invalidate a receipt assertion, because no receipt scenario reached execution.

The one-invocation authorization is consumed. Root must decide the correction and any fresh launch gate. Massload remains closed.

## Proxy correction and local sanity check

Root authorized this fixture-only correction after accepting the failed invocation's zero-admission/zero-worker result and independent cleanup. `decodedProxyResponse` now copies upstream headers, removes `Content-Encoding`, `Content-Length` and `Transfer-Encoding`, and rebuilds the decoded body while retaining status, status text and other headers. The actual authority proxy calls this function and records upstream encoding/length/transfer headers for the next authorized run. Only `architecture-docker-runtime.ts`, `architecture-docker-proof.ts` and this note changed during the correction. Production files were not edited.

An exported `proxySanityProbe` in the existing proof fixture starts two ephemeral loopback Bun listeners, has a five-second assertion deadline, and closes both listeners in finally. It uses a real gzip response with compressed length 31 and decoded length 11. The unchanged-header control reproduces `ZlibError`. The corrected proxy returns the original JSON, preserves `Content-Type`, `Cache-Control` and a synthetic semantic header, and succeeds through the production typed `HttpSandboxAuthority.status()` caller. A direct response assertion additionally verifies removal of all three incompatible metadata headers and preservation of HTTP 201 and its status text. This is a local HTTP transport check, with no Miniflare, DO/R2, Docker or attempt admission.

```sh
bun --no-env-file -e 'import { proxySanityProbe } from "./packages/loopy/_tests_/fixtures/architecture-docker-proof.ts"; await proxySanityProbe();'
```

Exit 0 in about 0.15 seconds. It prints one expected `Decompression error: ZlibError` from the negative control, then a passing JSON report with all three upstream observations showing gzip, compressed length 31 and decoded length 11. Evidence is `.loopy/architecture-tests/docker-proxy-sanity-400En9/report.json`. The test's allocated ports were 64509 and 64510. A separate read-only listener post-check and final four-fixture source inventory are retained beside that report.

Scoped TypeScript compilation, ESLint and Biome checks pass with the commands above. No existing test was deleted or moved. The prior failed invocation evidence remains intact in `docker-durable-BrvpjY`. The seven Docker/durable scenarios are still unproved. The full proof entrypoint has not run again. A rerun must receive a fresh explicit root gate after integrated checks and will create a fresh `docker-durable-<unique>` root. Massload remains closed.

## Fresh authorized proof result

Root opened a new one-invocation retry gate after accepting the proxy correction and causal sanity probe. The exact launch command above ran once with no global TMPDIR change. Exit 0. The fresh root was `.loopy/architecture-tests/docker-durable-MRu6UN/`. Its report interval was `2026-10-23T15:13:12.234Z` through `2026-10-23T15:13:34.939Z`, or 22.705 seconds. All seven planned scenarios passed. There were five durable attempt identities, four actual successful Docker start commands and no fifth start. No fixture or production source changed during this invocation. Both `changedSources` and `changedCriticalSources` are empty. No additional invocation is authorized or running.

The actual worker image IDs recorded by Docker inspection all match `sha256:ffc247b1e3a93dc0eafb8f387ed52d5b8fc7445e929a701f2117f6a0cc175722`. The bundled production Worker SHA-256 is `d0df7f44a9c8847476dfaa24e6ed81c23a4aca463adbe187a6f737fb15d135a1`. The root-derived owner label is `94971a740405e98d2992b034a99e2a7a747db49f66d4057366511e5927f8308d`. The authority DO persistence identity is `cffae60b42497dc210bf1efb12eb76b8b047c0ee2fa773ea9349ea3f789f5172`, under this fresh root's `do/-SandboxReceipts/` directory. These identify this run only.

Observed outcomes:

- Duplicate first admission started worker A once. A returned succeeded with output `{"proof":"A"}`. Repeated admission preserved success; changed content conflicted.
- Missing artifact authentication, invalid traversal and a foreign workspace were rejected. A real export helper ran, then injected cleanup failure left that exact stopped helper and its SQL guard present. Same-volume admission remained blocked before and after reconstruction while cleanup was injected unavailable.
- The bridge closed and actual workerd was disposed and reconstructed over the same SQLite/R2 root. A's plan, original session, terminal blob reference and result bytes remained identical. Its Docker container ID and StartedAt stayed unchanged after repeated admission.
- Restored cleanup removed the exact old helper, confirmed absence and released its persisted guard under the successor session. The proxy then replaced B's committed admission acknowledgement with HTTP 503 and rejected three resolving reads. Concurrent duplicate requests still produced one B start and succeeded output `{"proof":"B"}`. Actual exported `count.txt` was exactly `A\nB\n`, SHA-256 `daee1cd25194ae952d046ad9b9c81d3c07dc5332440b58d6d7461b248be56712`, size four bytes. No guard/helper remained.
- Worker C was observed Running and killed with actual Docker kill. It finished uncertain. Repeated admission preserved the terminal result, one start, container ID and StartedAt.
- Worker D was observed Running. The actual backend's outer deadline killed it and produced the exact execution failure `Attempt timed out. Its owned container was killed.` Repeated admission did not start another worker.
- The fifth admission committed, its acknowledgement was replaced with 503, and a resolving read failed before close began. Production `startSandbox.close()` completed in 0.452 ms while that proxy read outage remained in force. The outstanding HTTP request settled with its socket closed, the root lock was absent and no worker/container existed for the admission. A successor recovered it through the actual Docker backend as uncertain, with zero starts.

There were two deliberately replaced admission replies in total, three finite resolving-read failures for B and one observed read failure before shutdown of the fifth admission. Five accepted completion replies pointed to five retained content-addressed R2 blobs. An independent evidence pass matched every terminal reference's SHA-256 to exactly one retained R2 blob file. This confirms the recorded local bytes and terminal references, without adding an admission or starting another runtime.

The fixture's narrow cleanup reported zero errors. The separate read-only `independent-postcheck.json` then verified absence of all 15 exact possible worker/input-helper/artifact-helper names, all nine exact possible input/run volume names and any container carrying this fresh root's owner label. It checked the root lock was absent and `lsof` found no listeners on 50361, 50362 or 50379. These were the initial workerd, proxy and reconstructed workerd ports. No extra removal mutation was necessary. Final recorded StartedAt/FinishedAt intervals for all four workers are nonoverlapping, independently confirming observed maximum concurrency one. The same inspection records pin every actual worker to the supplied image ID.

All evidence remains under `docker-durable-MRu6UN`, including `report.json`, `evidence-summary.json`, `independent-postcheck.json`, both source inventories, Worker bundle hash, authority HTTP events, Docker commands, resource identities and hashed SQL/R2 files. The earlier failed `docker-durable-BrvpjY` and causal probe `docker-proxy-sanity-400En9` evidence are preserved. Only this proof note and new evidence were written during the successful run and post-checks. The four fixture files remain unchanged from their final preparation hashes. The test fixtures add 1,164 lines and delete zero against HEAD; no existing tests were deleted or moved.

The distinction between injection and actual process behavior remains the one in the assertion plan. HTTP 503 substitution and command-runner cleanup refusal are injected faults around actual authority/storage and Docker operations. Workerd reconstruction is graceful destruction/recreation. Actual worker kill, actual deadline kill, real helper presence/removal, real storage reconstruction and actual public bridge shutdown were observed. No claim is made for remote cloud durability, physical power loss, arbitrary delayed Docker fencing, bridge process crash recovery or arbitrary external-effect uniqueness. The later 525-run workload, broader integration checks and main remain with root and were not launched here.
