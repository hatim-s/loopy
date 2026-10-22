# Independent daemon wake review

Verdict: approve the daemon wake fix. No blocking correctness findings in the reviewed production or test changes. This is a minor bug fix for one admission problem: committed work did not interrupt the active daemon's idle wait.

Reviewed in `/Users/hatim.shakir/projects/loopy/cloud-integration`, branch `cloud-integration`, against HEAD `f692e0f0df17d71c86e2572acce9740307ddb7c1`. Read the repository AGENTS, `unslop`, `pr-review`, TypeScript review guidance, and `.notes/cloud/daemon-wake-fix.md`. Review ownership is this report only. Other concurrent changes are outside the verdict.

The reviewed diff contains 9 added and 1 deleted production lines in `packages/loopy/src/host/daemon.ts`, plus 91 added and 9 deleted test lines in `packages/loopy/_tests_/daemon.test.ts`. The former explicit-wake test was replaced by two committed-creation cases. No tests were moved in that diff.

## Causal findings

1. The event filter fixes the missing admission wake at its owner. `service/service.ts:176` admits a queued run through `store.createRun` without calling the daemon. The HEAD subscription accepted only `run.woken`. The new filter at `host/daemon.ts:77` also accepts queued `run.created` and `schedule.saved`. Both memory and SQLite publish after committing, so activation sees durable work. `local/daemon.ts:59` and `local/daemon.ts:61` give the daemon and HTTP service the same store instance. This explains the earlier 4791-4997 ms delays without requiring a slower executor or a new polling interval.

2. I found no missed wake across the scan-to-sleep handoff. `host/daemon.ts:112` sets a sticky request and aborts the current controller. A creation after a stale `dueRuns` snapshot makes `wait` return immediately. During `waitDuration`, the controller already exists, so an event aborts the signal subsequently passed to sleep. The default sleeper checks an already-aborted signal at `host/daemon.ts:29`. After wait cleanup clears the flag, the next scan reads current state. Independent gated probes exercised both the stale-snapshot and pending-deadline-lookup cases and completed the admitted run without releasing an idle sleeper.

3. The `running` guard preserves startup and manual ticks. Pre-run store events no longer leave a request that skips the first wait and doubles the failure delay. The initial scan discovers those records. `run()` reaches an await in startup pruning before it can scan schedules or runs, so its promise is installed before those asynchronous phases. Existing tests still observe the 1000/2000/4000/5000 ms activation failure backoff and the three expected deadline calculations. An independent probe created and durably woke a suspended run before any loop, then verified one successful manual tick, one empty tick, and no sleeper calls. `tick()` still performs a bounded scan and waits for its activations; it does not start a loop.

4. The new events do not create a self-sustaining busy loop. The predicate ignores claim, heartbeat, finish, release, node, log, terminal creation, and `schedule.fired` events. A schedule firing also commits a queued creation, which may request a redundant scan, but its transaction advances `nextFireAt` and records the fire key. Startup advancement emits `saved` once per successful advancement. The boolean request coalesces these notifications. With fixed time, subsequent scans have no new due schedule or wake-producing mutation. The new schedule tests reach one completed run and a stable 5000 ms blocked sleeper. Existing failed-activation tests also retain their backoff.

5. Schedule rules remain owned by the existing scheduler and store. Saves, edits, enable, and disable all emit `saved`; version checks still reject a stale fire after an edit or disable. Startup stale-schedule handling, the exact one-minute allowance, and fire-key deduplication are unchanged. Independent future-schedule probes observed the previous wait abort and the next requested delay change to 2000, 4000, and 5000 ms after save, edit, and disable, with no run created. Deletion remains ignored and can leave one unnecessary timeout. Separate SQLite instances still require polling. These are existing limits, documented in the fix brief.

## Test causality and limits

The new queued-creation tests at `packages/loopy/_tests_/daemon.test.ts:228` hold the injected sleeper indefinitely and assert its signal aborts immediately after creation. They never call `daemon.wake`. Completion cannot be explained by the five-second fallback. The SQLite case reads the run through a second connection during preparation, before activation claims it, and verifies the record was committed. This is same-instance admission with an independent visibility check; it does not test cross-connection notification.

The saved negative control records four failures on the aborted-signal assertions and one passing unrelated-event case. The HEAD daemon hash matches the recorded original hash. That isolates the missing subscription behavior; the passing control supports the filter's selectivity. I reviewed this receipt and did not temporarily replace production source to rerun it.

The schedule save and enable tests at `daemon.test.ts:264` use already-due store records. The HTTP service normally computes a future deadline when saving or enabling. Those tests prove notification and one-time dispatch, but do not by themselves prove future-deadline recomputation. The independent fixed-clock save/edit/disable probe covered that distinction. Disable/edit and the two handoff probes are review-time checks, not additional committed tests. This is a coverage limit, not an observed defect.

`waitDuration` still uses the existing backoff minimum at `host/daemon.ts:258`. Waking to recompute a future schedule does not guarantee exact cron timing when that minimum exceeds the remaining deadline. This fix makes no new precision guarantee.

The saved expanded test log reports 52 passes, 0 failures, and 964 assertions. The saved smoke JSON reports created-to-first-node delays of 7, 1, and 2 ms with unchanged runtime hashes during that measurement. These support the local HTTP path. I did not repeat either the HTTP smoke or the original 45-run batch, and the three measurements do not establish a stress-load distribution. Their first-node timestamp measures persisted node start, not the shell's exact OS start.

## Fresh verification

Executed:

```sh
bun test packages/loopy/_tests_/daemon.test.ts packages/loopy/_tests_/daemon-concurrency.test.ts packages/loopy/_tests_/wait-daemon.test.ts
```

Result: exit 0, **27 pass, 0 fail, 117 assertions**, across three files. This covers the new wake tests, durable hook wake, concurrency, shutdown, startup schedule races, manual ticks, deadlines, and failure backoff. SQLite access was confined to fresh temporary stores created and removed by the test fixtures.

Executed `bun --no-env-file -` with an inline deterministic probe using `MemoryStore`, a frozen clock, deferred gates, `FakeExecutor`, and an abort-controlled sleeper. No timer was allowed through the injected clock. Exit 0, with these exact outputs:

```text
PASS queued creation during scan snapshot completes without releasing an idle sleep
PASS queued creation during deadline lookup completes without releasing an idle sleep
PASS pre-run durable wake remains visible to manual tick, with no loop or sleep
PASS future schedule save, edit and disable abort old waits and recompute 2000/4000/5000ms without firing
```

Executed `git diff --check -- packages/loopy/src/host/daemon.ts packages/loopy/_tests_/daemon.test.ts`: exit 0, no diagnostics. `git diff --numstat HEAD --` for those files confirmed the counts above.

Executed:

```sh
shasum -a 256 packages/loopy/src/host/daemon.ts packages/loopy/_tests_/daemon.test.ts
git show HEAD:packages/loopy/src/host/daemon.ts | shasum -a 256
```

The production and test hashes matched the fix brief before and after verification:

```text
daemon.ts  6a10e9da5e231a2e71921a7fb932c48c9eb0b88437c15fd3720f55d3679edd5b
daemon.test.ts  0073a56ce0b5a3be4f70c5ae9120b774e945f4eb1cc781a09e1f1766b2f72bed
HEAD daemon.ts  eb25d53367b3e2e1f091d50b1e2961a78579ce5d08af305f33d9edebb298d1ca
```

During review, the smoke runner moved from `.notes/cloud/evidence/daemon-wake-smoke.ts` to `packages/loopy/_tests_/fixtures/daemon-wake-smoke.ts`. I read the current runner without executing it. The historical receipt remains in `.notes/cloud/evidence/daemon-wake-smoke.json`. The daemon and daemon-test hashes stayed unchanged.

No production edits, services, Docker, HTTP requests, cloud operations, credentials, existing databases, main-checkout work, commits, or children were used. I did not run the root fullcheck or claim a passing workspace gate. The parent still owns that gate before a push.
