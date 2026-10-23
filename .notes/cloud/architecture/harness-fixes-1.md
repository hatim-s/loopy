---
title: Harness review fixes for launch ownership and baseline gates
status: source stable, ready for independent round 2
date: 2026-10-23
head: 6ffecdfd60e16aaa335467684d918b3cd8b44813
---

# Scope and result

Fixed findings 1 and 2 from `harness-review-1.md`, plus the requested architecture image selection. This supplement replaces the earlier profile note's descriptions of supervisor identity, baseline acceptance and architecture image choice. Finding 3 and `verify-receipts.ts` remain root-owned and were not edited by this lane.

The review-fix delta is 709 added and 97 deleted source lines across 14 files, measured against the source snapshot taken before this fix round. Most additions are dedicated offline assertions and their disposable fixture builder. Exact before/after hashes and per-file line counts are in `harness-fixes-1-checks.json`.

The current whole-harness pin has 65 files and SHA-256 `e3b426b75e1d57f1a98dcfdd8599fe8438940a3b70d6013eab3d54a8ab66d7f4`. The aggregate uses sorted UTF-8 records `relativePath + NUL + fileSha256 + newline`, matching the review's method. This includes the current root-owned collector files solely to identify the shared snapshot.

# Finding 1

`start()` generates a fresh `crypto.randomUUID()` for every launch. Its detached child now receives normal explicit CLI flags:

```text
bun --no-env-file <root>/scripts/playground/index.ts serve --profile architecture --state-root <root>/.loopy/playground-architecture --launch-nonce <fresh UUID>
```

The unset profile passes `--profile default` and its own state path. The narrow `index.ts` grant added only the three serve identity flags and their forwarding. `serve` validates the flags against the selected environment and paths before process observation, port probes or initialization. Missing identity flags and old bare `serve` calls fail closed.

Before opening services, the supervisor observes its own PID, PGID and complete command. It requires a positive group leader with PGID equal to PID and an exact command matching the selected root, profile, state and nonce. The version-2 manifest persists positive owner/PGID, the full identity, and the exact executable/argv used for that comparison.

`stop()` parses that manifest, observes the recorded PID and verifies PID, PGID, group leadership, selected root/profile/state, canonical full argv and the fresh launch nonce before asking its process adapter to signal the group. It uses equality, not a command substring. Old manifests, a reused PID with a later nonce, another profile/state/root, absent processes and inconsistent process groups cannot authorize a signal. No automatic old-manifest adoption or state migration was added.

New or changed call signatures are:

```ts
serve(input: { profile: string | undefined; state: string | undefined; nonce: string | undefined }): Promise<void>
stop(control?: { selection: StackSelection; manifestPath: string; processes: SupervisorProcesses }): Promise<void>

interface SupervisorProcesses {
  observe(pid: number): Promise<{ pid: number; pgid: number; command: string } | null>;
  signalGroup(pgid: number): void;
}
```

`StackSelection` and `SupervisorIdentity` derive from the identity schema. The default process adapter runs `ps -p <pid> -o pid=,pgid=,command=` and signals the verified process group. Offline tests inject both adapter operations and never call that default adapter.

# Finding 2

`sampleSchema` moved from the executable segment-analysis script into `metrics-statistics.ts`. `Sample` now derives from that schema, and `metrics-segments.ts` imports it without changing its analysis behavior.

`requireCurrentBaseline` validates the actual saved capture metadata and every sample. Accepted phases are `baseline-small` and the already documented `baseline` alias. `baseline-empty`, during-load, matched and postload captures cannot arm load. The selected canonical directory and current batch checks remain.

The baseline requires one successful observation for each of the 14 unconditional comparison endpoints:

```text
runs.latest, loopies.counts, runs.waiting, runs.failed, overview.counts,
logs.latest, events.latest, daemon, runs.page2, runs.slug, logs.text,
events.run-filter, logs.page2, events.page2
```

A successful observation needs `failure: null`, a 2xx status, positive body bytes, a valid sample timestamp and non-null, nonnegative header/parse timing with nonnegative total timing. Conditional per-run detail endpoints remain outside this first gate. Root's full repeat will observe all 18 endpoints separately. Failed samples are retained in the raw file and in the parsed sample list; they do not satisfy successful coverage.

`arm(baseline: string, context?: ArmContext)` accepts an injected filesystem/profile context for offline verification. The CLI still resolves the selected config and batch normally. All baseline/source/preflight validation happens before the actual `load-enabled.json` write. The source marker, three passing current-batch preflights and four API/backend slots remain required.

Root's recommended sequence is now:

```sh
export LOOPY_PLAYGROUND_PROFILE=architecture
# Root launches and verifies the owned stack first.
bun --no-env-file scripts/playground/metrics.ts baseline-empty 90 2
bun --no-env-file scripts/playground/index.ts prepare
bun --no-env-file scripts/playground/index.ts preflight --group a
bun --no-env-file scripts/playground/index.ts preflight --group b
bun --no-env-file scripts/playground/index.ts preflight --group c
bun --no-env-file scripts/playground/metrics.ts baseline-small 90 2
bun --no-env-file scripts/playground/index.ts arm --baseline .notes/cloud/evidence/architecture/playground-performance-baseline-small.json
```

These are future root commands. This lane executed none of them. The empty capture remains useful evidence and is explicitly ineligible for arming. Standard speed, the 525 plus three cloud runs, the 45 daemon runs, approval distribution, global semaphore, locks and guards are unchanged.

# Architecture image

`playgroundProfile` now selects `loopy-sandbox:architecture-bun-1.4.0` for architecture and retains `loopy-sandbox:bun-1.4.0` when the variable is unset. `config.image` consumes that single profile setting. Assertions cover both values, and a temporary mutation restoring the old architecture tag fails the profile test.

Root must build the new tag after source stabilization and record the exact image digest before workload admission. This lane performed no Docker operation and does not claim the tag exists or contains current source.

# Exact offline assertions

The new tests call actual `stop()` and actual `arm()`. They use injected process observations/signal callbacks and fresh temporary source, preflight, baseline and gate files. Their printed signal/gate messages describe those injected/disposable operations. No OS signal, real process observation, API request, port bind, service or workload occurred.

- Matching positive PID/PGID/nonce/profile/state records exactly one injected group request for `424242`.
- Legacy command, wrong selected profile/state/root, later same-profile nonce, absent process, wrong PID/PGID, invalid/nonpositive owners, old manifest and altered argv each record zero signal requests.
- Missing or mismatched serve identity flags fail parsing.
- Null and malformed samples assert their exact schema issue path/message. Non-baseline phases assert the exact phase issue. Foreign batches and empty samples assert their exact issue.
- Real `createMeasure()` transport-failure samples for all endpoints assert the complete missing-coverage error and leave the disposable gate absent.
- Omitting each of the 14 endpoint successes independently asserts its exact endpoint error and gate absence.
- 500 status, zero bytes, missing header or parse time, negative duration and failed observations do not satisfy coverage.
- Valid same-batch `baseline-small`, with all endpoint successes and three passing preflights, writes the disposable gate with the correct batch/path. The documented `baseline` alias also passes. Failures appended to an otherwise usable capture remain unchanged on disk and in the parsed list.
- A missing third preflight, wrong batch and evidence outside the selected directory leave the disposable gate absent.

One earlier weak baseline-only test was replaced by these actual-arm assertions. No production behavior test was deleted. New test files are `baseline-gate.test.ts` and `stack-identity.test.ts`, with `baseline-fixture.ts` as the synthetic measurement producer.

# Checks, controls and limits

Focused tests passed in both unset and architecture environments: 18 tests, 173 assertions, five files. The two finding-specific files account for 10 tests and 114 assertions. Focused Biome and ESLint checks passed over the 14 touched source/test files; the harness TypeScript project passed with no output. `git diff --check` passed.

Eight controls mutated disposable source copies and each caused the expected assertion failure: remove exact command/nonce verification, remove PGID verification, remove selected profile/state/root verification separately, accept any baseline phase, bypass successful endpoint coverage, and select the historical image for architecture. Control subprocesses ran only offline tests with injected process operations.

Root reported its earlier full check as 1,252 passed and three skipped. This lane did not rerun or claim that broad check. Root has separately updated the collector and added harness tests to the package test command. A new root full check and independent round-2 review remain required.

Production source for this lane is stable at the hashes in the check receipt. Live platform command rendering, launch/stop behavior, image build/digest, ports, baselines, workloads and DO/R2 acceptance remain root checks. PID/PGID/argv observation is a process snapshot; it is not an atomic kernel handle spanning observation and signal. No old state, private credentials, main checkout, commits, cloud or shared services were touched.
