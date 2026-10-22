# Local playground driver

The playground uses only local Wrangler and the `colima-loopy-cloud-phase1` Docker context. The retained stack is independent of ports 4310, 4173 and 14870–14873. API, sandbox, dashboard and inspector use 15070, 15071, 15072 and 15073. State lives in `.loopy/playground`; the validated sandbox root is `.loopy/playground/runtime-root/.loopy/cloud/sandbox`.

## Commands

Run commands from this worktree with Bun's environment-file loading disabled:

```sh
bun --no-env-file scripts/playground/index.ts start
bun --no-env-file scripts/playground/index.ts status
bun --no-env-file scripts/playground/index.ts stop
```

`start` checks all four ports and creates a detached supervisor. `stop` verifies the recorded supervisor command before signaling its process group. It retains data, containers and volumes. It never stops the shared VM. The process manifest is `.loopy/playground/processes.json`.

Credentials are private in `.loopy/playground/config.json`. The authenticated dashboard bootstrap address is in `.loopy/playground/dashboard.url`. Read it privately in the browser; do not print or copy it into evidence. The dashboard API proxy points at 15070.

## Frozen source and load gate

`prepare` copies the three fixture groups, including modules/catalog.json, into an actual inner Git repository, compiles those copied sources and uploads through the authenticated API. The inner branch is `playground`, with a synthetic local author, no hooks and no remote. It has a frozen seed ref and source hash. Repeating preparation refuses changed source content.

The repository is `.loopy/playground/loopies-playground`. Seed commit is `9e649e9a8abcb2ec20e4379190b893c6876931b0`; source SHA-256 is `a213d51dab78b89a140ebcc1c792daa18558d9fb428330bdc21b650400de9c89`. `.notes/cloud/evidence/playground-driver-source.json` records all 15 compiled revisions.

Three passing preflight runs are separate from the primary batch. Their input batch has a `-preflight` suffix. Evidence is `playground-driver-preflight-{a,b,c}.json`. Group C exercised a visible approval hold before resolution. No primary load starts automatically.

After performance sampling and parent coordination, the parent opens the load gate:

```sh
bun --no-env-file scripts/playground/index.ts arm --baseline .notes/cloud/evidence/playground-performance-baseline-small.json
```

Each group lead then invokes its own command, concurrently with the other leads:

```sh
bun --no-env-file scripts/playground/index.ts cohort --group a
bun --no-env-file scripts/playground/index.ts cohort --group b
bun --no-env-file scripts/playground/index.ts cohort --group c
```

A and B each submit 200 primary runs; C submits 125. The first A and B fixtures each receive 100 runs; the remaining 13 receive 25. Ordinals divisible by six with remainder five deliberately fail for nonapproval fixtures. That produces 64 controlled failures and 461 successes, with 125 held approval runs among the successes. All inputs contain batch, ordinal, fail and items. Approval runs use fail:false. Each observed approval waits a deterministic 10–45 seconds, then resolves with approved:true.

## Client and evidence contract

Import `PlaygroundClient` from `scripts/playground/client.ts` and call `await PlaygroundClient.open()`. `settings` contains the private parsed config. `request('/runs', signal)` adds `/api`, authorization and a deadline, buffers the body while holding a global filesystem permit, then returns a Response. At most four driver responses are in flight. `json(schema, path, body?, method?)` parses the expected wire schema. A crashed permit is retained for explicit recovery.

Each group uses four observation workers, so the three cohorts can have twelve admitted nonterminal runs. Cloud scheduling concurrency is four runs. The local provider wrapper limits backend operations to four and preserves receipt deadlines while queued. This does not prove a hard live-container cap after a Docker transport fault. Such a fault or an uncertain result sets ABORT. A periodic guard checks owned active attempt containers and total container memory bytes divided by Docker VM MemTotal. It excludes short artifact helpers from the four-worker count. Guard failure or 85% VM container memory stops new admissions. Concurrent callers wait up to 35 seconds for the current check, then recheck ABORT and require a fresh successful sample. A dead owner fails closed and retains its lock for explicit recovery.

`runtime-queue.jsonl` records queuedAt, acquiredAt, finishedAt, queueWaitMs and backendDurationMs per execution identity and attempt. Backend duration includes Docker setup, worker execution and result inspection; it is not a measurement of worker CPU time. Recovery operations are not included in this start-only timing journal.

Each admission has an exclusive intent file in `.loopy/playground/journal/<phase>/<group>/<slug>-<ordinal>.json`. Fields include input identity, expected outcome, intentAt, admittedAt and runId. admittedAt is the local time after the admission response, rather than the server's creation timestamp. Transport ambiguity leaves runId:null and stops the cohort without a repeated POST. Adjacent `.progress.json` files retain observed wait, approval intent, resolution and completed result. Group JSONL events record admission, wait, terminal classification and artifact receipts.

Controlled failures require the authored marker, execution error code and the expected node in the pinned graph. Timeouts, uncertain outcomes and failures from another node cannot count as intended failures. Unpredictable outcomes set ABORT, including on inputs that deliberately request failure.

Successful runs export `loopies-playground/results/result.json` through the authenticated cloud artifact route. The driver checks path, size, SHA-256 and batch/ordinal/slug, then writes `results/<batch>/<slug>/<runId>.json` inside the host fixture repository. Existing files are accepted only when the bytes match. Frozen tracked sources remain unchanged; generated results stay visible in inner Git status. The driver preserves the raw result envelope and does not apply arbitrary files[] paths. Fixture leads own the additional semantic checks of their generated reports.

Runs share a Docker workspace volume across nodes and retries within that run. Different runs have separate volumes. Fixtures seed a logical repository copy in the volume, read it, and modify it. There is no host mount and no shared mutable runtime repository. The host mock repository is the compilation source and verified export destination.

## Recovery

A successful current-batch summary is skipped on rerun. A failed summary is not success. A cohort claim is never stolen automatically.

1. Inspect `.loopy/playground/ABORT`, the cohort lock, admission files, progress files, group JSONL and API snapshots.
2. For a dead primary cohort owner, run `bun --no-env-file scripts/playground/index.ts recover --group a`, substituting the affected group. This refuses a live PID, archives the lock and removes API permits only when their recorded owner is dead. It leaves ABORT in place.
3. Reconcile every admission with runId:null using the authenticated API and its exact slug, batch, ordinal, input and workspace. Assign a run ID only after proving the identity. Never delete an intent to resubmit it.
4. Approval intents reconcile against durable hook history. An unresolved ambiguous approval intent requires inspection before another POST. Completed results retain their original wait and resolution records; resumed artifacts must match their saved hash and identity.
5. A pressure-check.lock whose owner is dead remains in place. Verify the owner PID, preserve its metadata, and have the parent remove that stale pressure lock only after reconciliation. There is no age-based lock stealing.
6. The parent may remove ABORT only after reconciliation and resume the same cohort. Completed jobs return their durable result without another admission.

No fault injection, broad checks or source edits should overlap primary performance measurement without parent coordination. Keep the stack alive afterward for dashboard inspection.

## Validation and limits

Scoped TypeScript, ESLint and Biome checks cover the fifteen driver modules, excluding metrics modules owned by the performance lead. Focused executable checks cover maximum four backend operations, queued abort, an expired queued request starting no effect, rejection of uncertain and timeout errors, completion replay without increasing the API run count, idempotent exports and approval recovery without another POST. The memory guard check uses different container limits with equal absolute usage.

The parent owns independent reviews and load authorization. The single Luna helper implemented repository seeding with medium reasoning and default service tier; no review was delegated. No outer-repository commit or push was made.

A local Bun daemon comparison is feasible and is separately owned under `scripts/daemon-playground`. Its lead copied the frozen source into `.loopy/playground-daemon`, compiled and saved five representative workflows through the public CLI without executing them. The parent schedules its 45 runs after cloud measurement to avoid mixing resource usage. No claim of stale-token fencing or remote-provider behavior follows from this driver.
