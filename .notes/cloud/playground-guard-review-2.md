# Playground guard review, round 2

Verdict: accept the guard correction. No concrete blocker found in this narrow review. The round 1 P1 admission bypass is fixed. Root can use this result for its 525-run load gate decision. This review did not start the load.

Classification: minor feature, a local playground workload harness. This is not a production runtime review or evidence of live pressure protection.

## Reviewed source

Worktree `/Users/hatim.shakir/projects/loopy/cloud-integration`, branch `cloud-integration`, HEAD `f692e0f0df17d71c86e2572acce9740307ddb7c1`.

The guard is untracked in this checkout, so HEAD alone does not identify the reviewed bytes. SHA-256, verified again after the isolated checks:

```text
1213d36290bf1cf94a7587cc54d6320bda41cba2d6a6ccc29943af8b278c42a9  scripts/playground/guard.ts
2b7880588cb8a8e74faf50e39892dd32a7a023f03943bc2f89918be40b0b6d23  scripts/playground/config.ts
```

Read the supplied AGENTS instructions, repository AGENTS.md, unslop, pr-review, TypeScript guidance and round 1 report. Review scope was guard.ts, with config.ts read only to understand its imports and atomic writer. No delegates.

## Causal findings

- `guard.ts:111-134`: EEXIST now waits and retries acquisition. It cannot return success while another inspection is unresolved. Every retry checks ABORT; acquisition also checks ABORT after publishing owner metadata.
- `guard.ts:72-99,123-129`: owner JSON is read directly. ENOENT during normal release returns only from `waitOwner`, then the caller sleeps and retries acquisition. It does not return from `guard`. Other read errors and malformed owner data reject. Missing metadata cannot cause lock stealing and reaches the 35-second deadline.
- `guard.ts:89-99,157-166`: a dead owner rejects, writes ABORT and leaves the other owner's lock intact. The waiter never inspects or deletes that lock. PID reuse is not independently fenced; it cannot grant admission because the waiter still must acquire the directory and validate a successful sample.
- `guard.ts:138-155`: cache reuse requires a parsed `passed` sample, fewer than 30 seconds of timestamp age, nonnegative age, recent mtime, at most four running attempts and memory below 85 percent. Stale or future timestamps trigger inspection. Invalid recent samples fail closed. A failed inspection cannot publish a passed sample. ABORT is checked again before either success path.
- `guard.ts:48-62,170-202`: memory uses summed container usage bytes divided by Docker VM MemTotal. Individual container limits are not the denominator. Invalid usage text throws.

No additional actionable concurrency defect was found in the reviewed normal-release paths. Conservative rejection remains possible when owner liveness cannot be established; this closes admission rather than bypassing pressure inspection.

## Isolated verification

Ran `bun --version`, which printed `1.4.0`. Ran `bun --no-env-file -` with an inline assertion script; exit code 0. It read and transpiled the actual guard source and replaced filesystem, Bun, clock, process-liveness and config imports with in-memory substitutes. The Docker spawn substitute throws if invoked. The production function bodies were retained. Inspection was supplied through the guard's existing option.

The 35-second timeout used a virtual clock, not a 35-second wall-clock wait. The dead-owner case simulated ESRCH; it did not launch another process. These are local control-flow checks, not Docker integration tests.

Exact assertion output:

```text
guard sha256=1213d36290bf1cf94a7587cc54d6320bda41cba2d6a6ccc29943af8b278c42a9
PASS held failing inspector: waiter pending, both reject, one inspection, ABORT
PASS normal successful handoff: both resolve, one inspection, lock released
PASS dead owner: reject without inspect, ABORT, retain lock
PASS owner metadata unlink after EEXIST: retry acquisition, inspect before success
PASS missing metadata: 35s bounded wait, no inspect, ABORT, retain lock
PASS malformed owner: fail closed
PASS owner read error: fail closed
PASS cache fresh valid cache
PASS cache stale timestamp
PASS cache future timestamp
PASS cache invalid status
PASS cache 85 percent threshold
PASS cache too many containers
PASS cache zero VM total
PASS failed pressure cannot publish successful sample
PASS ABORT raised during inspection prevents success
PASS byte usage / VM total denominator and invalid usage rejection
```

The unlink case specifically forced mkdir to return EEXIST and the following owner JSON read to throw ENOENT while the directory disappeared. Success required a later acquisition and one inspection. Successful handoff used two concurrent guard calls, one held successful inspector, then cache reuse by the waiter. The failing handoff held the inspector unresolved, asserted the second caller remained pending, then released failure and asserted two rejections with exactly one inspection.

Read only the named driver evidence directory. Its ABORT files and retained dead-owner metadata corroborate fail-closed artifacts; they do not independently establish the driver's claimed execution sequence. Artifact SHA-256:

```text
256a46ca4502bf87e5ff01ef85bc37d7e686c294e2ac5ca18fae99fe72a52ef0  concurrent-failure/ABORT
256a46ca4502bf87e5ff01ef85bc37d7e686c294e2ac5ca18fae99fe72a52ef0  dead-owner/ABORT
df097f62f4284082603d68a7e46c81c387382aa4fc9a67681e6658915066961d  dead-owner/pressure-check.lock/owner.json
```

Hashes were obtained with `shasum -a 256`; identity with `git rev-parse HEAD` and `git branch --show-current`. An initial read-only shell command used zsh's special `path` variable and lost command lookup inside that subprocess. It was corrected and rerun; it changed no files.

Only this report was written. No source edits, test files added or deleted, broad tests, credentials, live API, database, Docker or service actions, commits, pushes or main changes. No production additions or deletions to report. The isolated checks establish the reviewed admission logic; live scheduling, actual Docker output and the mass load remain outside this verdict.
