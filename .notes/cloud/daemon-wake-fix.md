# Daemon wake fix

The idle daemon now wakes when its store commits a newly queued run or saves a schedule. Production ownership is limited to `packages/loopy/src/host/daemon.ts`. The branch is `cloud-integration` in `/Users/hatim.shakir/projects/loopy/cloud-integration`.

## Mechanism and scope

`service/service.ts:startRun` calls `store.createRun` with status `queued` and sends no explicit daemon wake. Both `store/memory-events.ts:commit` and `store/sqlite/events.ts:commit` publish events after commit. Before this change, the daemon subscription accepted only `run.woken`. A new queued run could therefore wait for the existing five-second idle poll. This agrees with the earlier 45-run report's 4791-4997 ms first-node delay. That batch was not repeated here.

The subscription now accepts:

- `run.woken`, preserving durable wait and hook wake behavior.
- `run.created` when the committed record is `queued`.
- `schedule.saved`, so saves, edits and enable or disable mutations interrupt the wait and recompute deadlines.

Events wake only an active `run()` loop. Preloaded records are handled by the initial scan. Carrying their wake into startup would skip its first wait and increase the existing failure backoff from 1000 ms to 2000 ms. The existing deadline and activation-failure tests caught this during implementation; the running-loop guard preserves their behavior.

No reducer, store, HTTP contract, scheduler, pool or sleep implementation changed. Existing `wakeRequested` and abort handling cover events arriving before or during the wait. No polling loop or shorter interval was added.

Heartbeat, claim, finish, release, node, log and nonqueued creation events remain outside the wake filter. `schedule.fired` is also ignored. A scheduler-created queued run can request one redundant scan, but each transaction creates at most one request and the schedule advances atomically. Startup `advanceSchedule` also emits `saved`, so it can request one extra scan after advancing stale schedules. It does not repeat once the schedule is current. Schedule deletion cannot bring work forward and remains ignored; its old timeout can cause one unnecessary scan.

The existing schedule deadline and backoff calculation is unchanged. This is a wake fix, not a new precision guarantee for cron deadlines. Separate SQLite connections or processes do not share in-memory subscriptions; their writes still depend on polling. Local HTTP admission uses the daemon's store instance and receives the immediate wake.

## Tests and negative control

The existing manual-wake test in `packages/loopy/_tests_/daemon.test.ts` was replaced with memory and SQLite committed-creation cases. They hold the injected sleeper indefinitely, assert the original 5000 ms sleep is aborted without calling `daemon.wake`, and verify completion. SQLite preparation reads through a second connection and verifies that the admitted record is already committed before activation.

Additional focused cases prove that schedule save and enable wake the daemon, produce exactly one successful run, and return to a stable 5000 ms idle sleep. An unrelated-event case proves heartbeat, finish, release and terminal creation leave the existing wait intact. Tests reuse the file's injected clock, sleepers, store setup and executor fixture. No tests were moved. The one replaced test no longer supplies the manual wake that hid this bug.

Before changing production source, this command produced **4 failures and 1 pass**:

```sh
bun test packages/loopy/_tests_/daemon.test.ts --test-name-pattern 'committed queued|schedule (save|enable) interrupts|unrelated run'
```

Each failure was the same boundary assertion, `Expected: true`, `Received: false`, on the existing idle signal's `aborted` value. Both stores and both schedule mutations failed; the unrelated-event test passed. The original-source SHA-256 was `eb25d53367b3e2e1f091d50b1e2961a78579ce5d08af305f33d9edebb298d1ca`. See `evidence/daemon-wake-negative.log`. The same selected command passes after the fix, **5 pass, 0 fail**.

The final expanded command passed **52 tests, 0 failures, 964 assertions**:

```sh
bun test packages/loopy/_tests_/daemon.test.ts packages/loopy/_tests_/daemon-concurrency.test.ts packages/loopy/_tests_/wait-daemon.test.ts packages/loopy/_tests_/local-daemon.test.ts packages/loopy/_tests_/server.test.ts
```

See `evidence/daemon-wake-focused.log`. This includes concurrency, shutdown, durable hook wake, deadline/backoff, startup schedule races, HTTP and SSE coverage. The server tests intentionally log SSE slow-client errors; the suite still exits 0.

These commands also passed:

```sh
bunx biome check packages/loopy/src/host/daemon.ts packages/loopy/_tests_/daemon.test.ts packages/loopy/_tests_/fixtures/daemon-wake-smoke.ts
bunx eslint packages/loopy/src/host/daemon.ts packages/loopy/_tests_/daemon.test.ts
bunx tsc -p packages/loopy/tsconfig.portable.json
```

Biome printed `Checked 3 files in 4ms. No fixes applied.` ESLint and portable TypeScript exited 0 without diagnostics. Receipts are `evidence/daemon-wake-lint.log` and `evidence/daemon-wake-portable-typecheck.log`.

`bun run typecheck` exited 2 on an unowned workspace diagnostic:

```text
scripts/playground/metrics-request.ts(36,35): error TS2504: Type 'ReadableStream<Uint8Array<ArrayBuffer>>' must have a '[Symbol.asyncIterator]()' method that returns an async iterator.
```

See `evidence/daemon-wake-typecheck.log`. That file was not changed here. The parent owns the final full `bun run check`; this task does not claim a passing workspace gate.

## Bounded real daemon and HTTP smoke

The only real measurement used one source CLI daemon and exactly three sequential HTTP-admitted shell runs. It used an ephemeral port assigned by the OS, 54608, and a fresh temporary workspace, home, and child process home. Each admission followed a deliberate 200 ms idle period. No external cloud, Docker, protected port, or `~/.loopy` state was used.

```sh
bun --no-env-file packages/loopy/_tests_/fixtures/daemon-wake-smoke.ts
```

The original command used the runner's former path, `.notes/cloud/evidence/daemon-wake-smoke.ts`. It exited 0 and printed a receipt path with `runs: 3` and `exitCode: 0`. The command above shows the retained manual entry point after relocation; it was not re-executed. All original runs returned stdout `daemon-wake-smoke`, empty stderr and shell exit code 0.

- Run 1: HTTP admission 15.964 ms; created-to-first-node 7 ms; request-start-to-node 17 ms; daemon-startup-to-node 242 ms; process-spawn-to-node 353 ms.
- Run 2: HTTP admission 2.358 ms; created-to-first-node 1 ms; request-start-to-node 3 ms; daemon-startup-to-node 644 ms.
- Run 3: HTTP admission 2.131 ms; created-to-first-node 2 ms; request-start-to-node 3 ms; daemon-startup-to-node 1044 ms.

The startup deltas share a single daemon. The later values include the preceding runs and deliberate idle periods. First-node time is the persisted node start timestamp, not a measurement of the exact OS instruction at which the shell begins. This three-run smoke proves the local admission path wakes promptly; it is not a repeat or statistical comparison of the earlier 45-run stress batch.

Both before and after the measurement, all 266 runtime source files hashed to `7d99f651375bd122b9492e3492ebd561d979a2c9b554d3e94a719ea54fed590c`. The daemon file hashed to `6a10e9da5e231a2e71921a7fb932c48c9eb0b88437c15fd3720f55d3679edd5b`. No runtime source changed during measurement. Raw timing, run IDs, source hashes and cleanup evidence are in `evidence/daemon-wake-smoke.json`; the retained runner is `packages/loopy/_tests_/fixtures/daemon-wake-smoke.ts`.

The owned daemon exited 0, removed its discovery file, and its temporary root was deleted. A separate post-run check verified that its PID was absent and the isolated root no longer existed. No daemon was adopted or stopped outside this task.

## Stable handoff

- Production diff: 9 lines added, 1 deleted in `packages/loopy/src/host/daemon.ts`.
- Dedicated daemon tests: 91 lines added, 9 deleted in `packages/loopy/_tests_/daemon.test.ts`.
- Final daemon SHA-256: `6a10e9da5e231a2e71921a7fb932c48c9eb0b88437c15fd3720f55d3679edd5b`.
- Final test SHA-256: `0073a56ce0b5a3be4f70c5ae9120b774e945f4eb1cc781a09e1f1766b2f72bed`.

No other production files were changed. No commit, push, child agent, remote operation or 45-run rerun was performed. The remaining gate is the parent's workspace fullcheck after resolving unrelated workspace diagnostics.

## Runner relocation

The retained standalone runner moved from `.notes/cloud/evidence/daemon-wake-smoke.ts` to `packages/loopy/_tests_/fixtures/daemon-wake-smoke.ts`. Imports and repository-root discovery now resolve from the fixture directory. Receipt and log output paths still point to `.notes/cloud/evidence`. It remains a manual script without a `.test` suffix.

Repository checking also required replacing the request helper's broad `object` parameter with the contract's `Json` type and capturing the validated origin before the nested helper. Formatting follows the repository lint rules. Production code and daemon tests were not changed during this relocation.

The original receipt and both logs are byte-for-byte unchanged. The receipt SHA-256 remains `51ec2d128ff4856871fd95433a3d104d2c681eef1edf72ef0f0c1537d5a8170b`. No smoke execution or new runs occurred after the move.

Relocation checks passed:

```sh
bunx biome check packages/loopy/src/host/daemon.ts packages/loopy/_tests_/daemon.test.ts packages/loopy/_tests_/fixtures/daemon-wake-smoke.ts
bunx eslint packages/loopy/_tests_/fixtures/daemon-wake-smoke.ts
bun run typecheck
```

Biome printed `Checked 3 files in 4ms. No fixes applied.` ESLint exited 0 without diagnostics. Full workspace typechecking, including the moved fixture and portable package, exited 0 without diagnostics after the metrics owner fixed the unrelated TS2504. A separate temporary TypeScript project extending the repository's `tsconfig.json` and including only this runner also passed with its transitive imports. The temporary config was deleted.

Receipts are `evidence/daemon-wake-runner-move-biome.log`, `evidence/daemon-wake-runner-move-eslint.log`, `evidence/daemon-wake-runner-move-typecheck.log` and `evidence/daemon-wake-runner-move-scoped-typecheck.log`. These type and lint checks do not execute the runner. The parent still owns the full `bun run check` gate.
