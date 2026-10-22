# Playground review 1

Verdict: request changes for one P1 admission blocker in the reviewed source. Keep the primary load gate closed until a fresh review accepts the guard correction. No additional concrete blocker found in the requested scope. No data corruption was observed or induced.

## Scope and snapshot

- Category: major feature. The scripts and fixtures implement one local workload exercise.
- Checkout: `/Users/hatim.shakir/projects/loopy/cloud-integration`, branch `cloud-integration`, HEAD `f692e0f0df17d71c86e2572acce9740307ddb7c1`.
- Reviewed 15 driver TypeScript files excluding `metrics*.ts`, plus all 47 fixture files. Read the relevant contract, reducer and sandbox source to check assumptions. Read AGENTS.md, unslop, pr-review, TypeScript craft and worktree-management instructions.
- Recomputed fixture source hash: `a213d51dab78b89a140ebcc1c792daa18558d9fb428330bdc21b650400de9c89`. This matches the recorded source freeze. The seed commit `9e649e9a8abcb2ec20e4379190b893c6876931b0` and three successful preflights are supplied context, not independently re-executed or verified against live state here.
- Catalog and ordinal rule produce 525 primary runs: 200 each for a and b, 125 for c. They predict 461 successes and 64 controlled failures. The 125 approval runs are part of the successes. The three preflights remain outside the 525.
- The driver changed guard.ts after the proof. The later hash observed was `ef593ea66a28356a90dd7b171116bc3023077d05cb4b3ba12acc997b9f43c27e`. That correction is outside this review verdict. The manifest below pins the earlier reviewed guard bytes and the unchanged files.
- Inspection and proof occurred on 2026-10-22 around 20:06 to 20:10 UTC. File hashes, rather than HEAD alone, identify these uncommitted sources.

## Finding

### P1. Pressure lock contention authorizes admissions without a successful check

Location: `scripts/playground/guard.ts:40-43` in reviewed hash `722644bcc719adc8d49a20dd72bae7a43258993701f5c92462cfe202a29a2f01`.

`mkdir(pressure-check.lock)` returning EEXIST makes guard return successfully. This does not prove that the lock owner has finished its Docker checks, that its check passed, or that a recent successful sample exists.

The primary cohorts have up to twelve driver workers. One worker can enter a slow pressure check while another sees the lock and passes guard. That second worker can then persist admission intent and POST a run at `run.ts:40-62`, or resolve approval at `approval.ts:49-65`. The first check can subsequently fail and set ABORT. These are admissions that the pressure guard was intended to block. The cohort's extra guard call does not repair the bypass, because it takes the same EEXIST branch.

A process death while holding this directory leaves the same successful bypass for all future calls until someone removes it. The reviewed `cohort.ts:118-143` recovery covers cohort locks and API slots, not pressure-check.lock.

Smallest fix: wait a bounded time for an in-flight pressure check to finish, then recheck ABORT and require its fresh successful sample or perform a new check under the lock. A stale lock must fail closed or require explicit dead-owner recovery. Recheck ABORT after waiting or acquiring the lock. Keep the existing bytes divided by Docker VM total memory calculation.

Proof: the isolated test below ran the actual reviewed guard function with in-memory filesystem and Bun process substitutes. A second call returned while the first mock Docker inspection was unresolved and no successful sample existed. Releasing that inspection with exit code 1 made the first call throw and set the mock ABORT. A stale-lock case returned without making another Docker call.

Root was notified immediately via T3 thread send. Root acknowledged the blocker, kept the gate closed and requested a separate review of the final correction. No source edit was made by this reviewer.

## Parent fixes checked in source

- `outcomes.ts:85-117` accepts expected failures only when the run failed with the fixture marker, a failed node matches the expected pinned graph node, and every failed node has execution code plus that marker. The ten rules cover all ten non-approval fixtures. Propagated branch failures retain the original execution error in the reducer, so the all-failed-nodes check does not reject the intended branch fail fixtures merely for having a failed control node.
- `run.ts:31-37,57-65` persists intent before POST and refuses to resubmit an admission whose run ID is unknown. Existing known admissions reuse their run ID. This intentionally requires manual reconciliation after an ambiguous transport result.
- `approval.ts:19-31,37-68` persists the observed wait and its due time, persists resolution intent before POST, and reconciles a matching resolved hook payload after a lost response. It refuses a second unresolved intent. The five approval fixtures each use one approval wait, so the single persisted wait matches this frozen cohort.
- `run.ts:82-91,135-149` reuses completed progress and checks saved artifact bytes, hash and input identity. A crash after export but before progress persistence re-enters export against the same admitted run. `artifacts.ts:69-84` accepts identical existing bytes and rejects differing bytes without overwriting.
- All fifteen catalog entries require the same bounded result artifact path. On success, `artifacts.ts:43-63` checks export path, byte length, SHA-256, batch, ordinal and slug before collection. Expected controlled failures do not export success artifacts. Fixture modules use the same identity envelope and per-run workspace location.
- `cohort.ts:30-39` skips only passed summaries for the current batch. Failed summaries proceed through explicit lock recovery. `cohort.ts:118-156` refuses live-owner recovery and leaves ABORT for the parent to reconcile.
- `client.ts` holds each filesystem API slot through full response buffering, then releases it in finally. This closes the earlier response-header-only concurrency gap.
- `runtime-limit.ts` shares its four-operation limit between start and recovery, removes aborted queued entries, checks attempt deadline after queue acquisition and records queue wait separately from backend duration. This is source inspection, not proof of runtime timing under load.
- `guard.ts:68-76,105-136` now sums container memory bytes and divides by positive Docker VM total bytes. The isolated arithmetic case below confirms why per-container MemPerc sums would give the wrong denominator. This causal correction is accepted independently of the lock blocker.

These are source conclusions. They do not certify the preflights, primary load performance, live receipt recovery, or metrics collectors.

## Isolated proof

Exact successful command, run from the checkout with Bun v1.4.0. Every mutation below is to JavaScript variables or mock objects. It opens no socket, invokes no Docker process and writes no filesystem state. This reproduction applies to the reviewed guard hash, not the later correction.

```sh
bun --no-env-file - <<'TS'
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { z } from 'zod';
const source = readFileSync('scripts/playground/guard.ts', 'utf8');
console.log('guard source sha256=' + createHash('sha256').update(source).digest('hex'));
let locked = false;
let abort = false;
let releaseFirst!: () => void;
const firstCheck = new Promise<void>((done) => { releaseFirst = done; });
let dockerCalls = 0;
(globalThis as any).reviewDeps = {
  z,
  mkdir: async () => { if (locked) { throw Object.assign(new Error('exists'), {code:'EEXIST'}); } locked = true; },
  rm: async () => { locked = false; },
  stat: async () => { throw new Error('no successful pressure sample'); },
  writeFile: async () => { abort = true; },
  Bun: {
    file: () => ({exists: async () => abort}),
    spawn: () => {
      dockerCalls += 1;
      return {stdout: new Response('').body!, exited:firstCheck.then(() => 1), kill: () => {}};
    },
  },
};
const patched = 'const deps=globalThis.reviewDeps;\n' + source
  .replace('import { mkdir, rm, stat, writeFile } from "node:fs/promises";', 'const {mkdir,rm,stat,writeFile}=deps;')
  .replace('import { z } from "zod";', 'const {z}=deps; const Bun=deps.Bun;')
  .replace('import { dockerContext, sandboxState, state } from "./config.js";', 'const dockerContext="fake-context", sandboxState="/isolated/runtime", state="/isolated/state";');
const compiled = new Bun.Transpiler({loader:'ts', target:'bun'}).transformSync(patched);
const {guard,memoryPressure} = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
const first = guard();
while (dockerCalls === 0) { await Bun.sleep(1); }
await guard();
assert.equal(abort, false);
assert.equal(dockerCalls, 1);
console.log('PROVED concurrent caller returned before first Docker result, with no successful pressure sample');
releaseFirst();
await assert.rejects(first, /could not inspect runtime/);
assert.equal(abort, true);
console.log('PROVED first check subsequently failed and set ABORT');
locked = true; abort = false;
await guard();
assert.equal(dockerCalls, 1);
console.log('PROVED stale pressure lock returned success without any Docker check');
assert.deepEqual(memoryPressure(['256MiB / 256MiB','256MiB / 256MiB'], 8*1024**3), {usedBytes:512*1024**2, percent:6.25});
console.log('PASS memory denominator: two full 256MiB containers on 8GiB VM = 6.25%');
TS
```

Exit code 0, output:

```text
guard source sha256=722644bcc719adc8d49a20dd72bae7a43258993701f5c92462cfe202a29a2f01
PROVED concurrent caller returned before first Docker result, with no successful pressure sample
PROVED first check subsequently failed and set ABORT
PROVED stale pressure lock returned success without any Docker check
PASS memory denominator: two full 256MiB containers on 8GiB VM = 6.25%
```

The first harness attempt exited 1 with `ReferenceError: deps is not defined` during data-module initialization. It ran no guard operation. The successful command above fixes the test harness binding through globalThis.

The separate source-only Bun calculation read fixture files, reproduced repository.ts source hashing and counted catalog runs with the ordinal fail rule. It exited 0 and printed:

```json
{"fixtureCount":47,"fixtureSourceHash":"a213d51dab78b89a140ebcc1c792daa18558d9fb428330bdc21b650400de9c89","primaryRuns":525,"controlledFailures":64,"successes":461,"approvalRuns":125}
```

Other commands were read-only `pwd`, `git status --short`, `git rev-parse HEAD`, `git branch --show-current`, `git diff --stat -- scripts/playground packages/loopy/_tests_/fixtures/playground`, `rg --files`, bounded `rg -n`, `cat`, `nl -ba`, `wc -l`, `shasum -a 256`, and UTC `date`. HEAD and branch matched the brief. Diff stat was empty because the scoped files are untracked; the source manifest below includes them.

No workloads, application API queries, credential reads, Docker commands, database access, service signals, broad checks, delegation, commits, or cloud/main operations were performed. Services 4310, 4173 and 14870 through 14873 were untouched. No tests were added, deleted or moved. The reviewer writes only this report.

## Source manifest

SHA-256 values for the reviewed uncommitted snapshot. Guard uses the earlier proven hash explicitly. All other files retained their initial hashes during review. These newly added scoped files contain 3262 lines added and zero deleted at that snapshot. Reviewer code changes: zero lines added and zero deleted.

```text
b44dc0c25767158d6084e1b70c8e8750301576412b5b52249ae5e3888b5b0199  packages/loopy/_tests_/fixtures/playground/a/changelog-approval.ts
ba9e1dbeb2f0eaadba912c34cc8f8094e84618d5bec261da4e9872b524e28655  packages/loopy/_tests_/fixtures/playground/a/dependency-audit.ts
6dba9484a0d90fd93a554b4316d3b2d3f074304f7fe747286921ea531baae881  packages/loopy/_tests_/fixtures/playground/a/format-report.ts
cc9cfa89d79e0dfe1ac49f225cf7b327fc9c0f96685e475f896470dc5626ed79  packages/loopy/_tests_/fixtures/playground/a/generated-docs.ts
406e96eb46e580ec5426e675e2550bdb57945be330cdc0015e27d24fea756a70  packages/loopy/_tests_/fixtures/playground/a/lint-report.ts
bbe2d5a68e97658f498c17f55a27a3da40bfe6729e981fff96b2882961b1969f  packages/loopy/_tests_/fixtures/playground/a/modules/catalog.json
9db9ede5e03354f61ab5ac7d56c5444521f6218d82c9b9c02b697bacece31d3d  packages/loopy/_tests_/fixtures/playground/a/modules/changelog-draft.ts
1c8dd9b486d47f17a5b59cc52c27cc24e63f1579a20d0ccabcc9f6892dc2a1a0  packages/loopy/_tests_/fixtures/playground/a/modules/changelog-publish.ts
d31c0480b4f51e607acfa8230b06c042de7df995ffbdca70473283a1eb3a64f2  packages/loopy/_tests_/fixtures/playground/a/modules/dependency-report.ts
c8182cfd423889667e1fc899365e8e316f6e465472b1538c691f113b28057354  packages/loopy/_tests_/fixtures/playground/a/modules/dependency-scan.ts
8e6632da924b3ce5ca51fab44c6aa59958966ec36911b9d75b4a35d49d3c20c5  packages/loopy/_tests_/fixtures/playground/a/modules/docs-publish.ts
401881118a28e0b7de7ee309262ca675e5b74d717c48591b3e9f6ca71394eacd  packages/loopy/_tests_/fixtures/playground/a/modules/docs-section.ts
23320fdca83376844dce82c0ca312c19d44dc0c97ed78ca1f86438387fa39b50  packages/loopy/_tests_/fixtures/playground/a/modules/format.ts
06fdec5d6e6dfaef803968f045d0f3d8e423a2a6126a8cb951897412bb1b6b93  packages/loopy/_tests_/fixtures/playground/a/modules/lint-report.ts
51e19938853180523bb4495f161eb2c979be6b54e38e1939e1608a02877d546a  packages/loopy/_tests_/fixtures/playground/a/modules/lint.ts
08269d5583902e3298bf0f86ee0ba03570086e8921a8888eba71a7e6e5797684  packages/loopy/_tests_/fixtures/playground/a/modules/repository.ts
c37bce20a042f3024e62664ebd00fcaf76c1cb03b94798806fbc3d7eb28da059  packages/loopy/_tests_/fixtures/playground/a/modules/seed.ts
41a50dddb60039ba482a91c66517a91de69188e42b9bc712961d0b27656ad589  packages/loopy/_tests_/fixtures/playground/b/log-audit.ts
0d114dec5650fd6e491fd57a3c92eb306e72f305ee0ee028e52cd45f5561c8ba  packages/loopy/_tests_/fixtures/playground/b/modules/audit.ts
b0636e3a8a9d78217a7e078dc4d53c6cd52a7df4b21ddaaa81e6be9f071213b1  packages/loopy/_tests_/fixtures/playground/b/modules/build-report.ts
bb465a07f81f115c9ca5b3edb5897153926e8b86cac7afd7bef96d0032a8e660  packages/loopy/_tests_/fixtures/playground/b/modules/build-target.ts
0e816e48c18fb212e1df3606c495c3d8ca13d565a2559f17eea8267fc4c49f3e  packages/loopy/_tests_/fixtures/playground/b/modules/catalog.json
e6a35139622165c64c943d4ecad56ef862e7a6034950209d451fdf8c92cc4776  packages/loopy/_tests_/fixtures/playground/b/modules/matrix-report.ts
fece180c442518989b742061c07265514ab2f3a42f0a6f3e9c6c6d4adcc9b29d  packages/loopy/_tests_/fixtures/playground/b/modules/matrix-shard.ts
f98ff38e6fc65fbb4e3a6d8118c6d0493efdd9db78aa409e54d6ff66782ff8d9  packages/loopy/_tests_/fixtures/playground/b/modules/release.ts
0d8be225bc7c1486965054483d890369b37d9ce72a0765c35cfeefc932a82361  packages/loopy/_tests_/fixtures/playground/b/modules/repository.ts
ce182af36104cd0bdfac1ae39c8a1d1c51ee1ac5a7b80bad64a8cfda989db5e7  packages/loopy/_tests_/fixtures/playground/b/modules/retry-marker.ts
f74d3fa9d9dfa4114266797116ac3d728e152e413af5f8187365f1e3dc0e8139  packages/loopy/_tests_/fixtures/playground/b/modules/seed.ts
de1ed12e012542e7bf6ab0d5afcb7408ea93cc344d45a379d19f56238a107f26  packages/loopy/_tests_/fixtures/playground/b/parallel-build.ts
0e7eba2bfa4bfa63422720c1f055136ce253085321b9beee7e8c264e4c5ae93d  packages/loopy/_tests_/fixtures/playground/b/release-approval.ts
ad7babab713dfc6e1c44c6463b5e7f1e62455ab2f093784265096f58ec864d72  packages/loopy/_tests_/fixtures/playground/b/retry-marker.ts
11a6fa6c75b9bf5420c60fe095553e670d51a93edcd52417ab08ff4e0ac57a99  packages/loopy/_tests_/fixtures/playground/b/test-matrix.ts
f6713b09787d3abbb0585696d1bcbae9ccc0b9e4b939868b08d6bf7ac02193c0  packages/loopy/_tests_/fixtures/playground/c/artifact-manifest.ts
113af59c593ab4f9ebf7e9eecac754272d2d448991f4414b438772494396a15d  packages/loopy/_tests_/fixtures/playground/c/data-migration.ts
97e1a15216efbfdf606442862f3d6c66253fd9ef33bb51df14dbe568d51ce641  packages/loopy/_tests_/fixtures/playground/c/modules/catalog.json
977a10287a68eb8ca235b1883a31c45ce69401fedce0e152bae87b9cded3aaaf  packages/loopy/_tests_/fixtures/playground/c/modules/manifest-plan.ts
56f69d58e1d35d90c6a453c0a682f38ee5d63e56e3813ab9cbed85b16db9068f  packages/loopy/_tests_/fixtures/playground/c/modules/manifest-publish.ts
0ec95551f1301a4012642f78708d542664ba37c06b5598c6c3933300c767cc0c  packages/loopy/_tests_/fixtures/playground/c/modules/migrate.ts
a95c09b89a4396fc6932175bd409610778d426a13259d74658b8dfc49af69ebd  packages/loopy/_tests_/fixtures/playground/c/modules/repository.ts
7dd0e63dbc7a85bfff67ef3474fd2fdfbe95e03609149e051099dce39a99f9eb  packages/loopy/_tests_/fixtures/playground/c/modules/resume-report.ts
e79670ce8a84806d06e32a03f2bc3e0a057e68792fb52fc9c37997ba020efd88  packages/loopy/_tests_/fixtures/playground/c/modules/security.ts
2a9fcd263747e95e604256028bca24f8aecca0b52895fd4375c2eadbdbc1ae3e  packages/loopy/_tests_/fixtures/playground/c/modules/seed.ts
13667ba3d9c0b7759bf3cad838eaf099b8befe19551457ac0fcd000ab41eacad  packages/loopy/_tests_/fixtures/playground/c/modules/validate-file.ts
30705fbf695b21a0f8d623a1759094b44e9b488bcada046ca7e20290379ed150  packages/loopy/_tests_/fixtures/playground/c/modules/validation-report.ts
d0f0974a8881e3540452bc64d3100aad8b49dd67463bdceee4fa2558399c0567  packages/loopy/_tests_/fixtures/playground/c/repository-validation.ts
b6994c5792ef30d2774b1ea37edd5d031dfe74e157ecc5553f3f9c2a6212802c  packages/loopy/_tests_/fixtures/playground/c/security-review.ts
49538b30a3c7d691d6eecba237903bd560e176bb0693b08326542065dad2c7af  packages/loopy/_tests_/fixtures/playground/c/sleep-resume.ts
5d907733c9c2c8c83d8fb1718482fc7237e6a4aa2ad524eefcd46549bf82f5ee  scripts/playground/approval.ts
6ff4d71ff37f5942579a56ce3dded1399f62253907897799f938c51870161c42  scripts/playground/artifacts.ts
7806673911064109207e2a721494a4367cb522f62f1303ee8cd931046f924aa0  scripts/playground/client.ts
f7d5038d8c5f10a7a7bad2ff53e806cbb36198c6afd8d8598b1fa96555a364fd  scripts/playground/cohort.ts
2b7880588cb8a8e74faf50e39892dd32a7a023f03943bc2f89918be40b0b6d23  scripts/playground/config.ts
722644bcc719adc8d49a20dd72bae7a43258993701f5c92462cfe202a29a2f01  scripts/playground/guard.ts
3b8e0837b6963b58c1edce4dc47820c2a378a742843d2aaa110e8f84277fe6f0  scripts/playground/index.ts
d5b0dfccb453a5dc48c51cb8117937447969e9a647f8282f05830346403aa992  scripts/playground/journal.ts
e6de226126461b46d11b9708961f737e9c1ed2e07cc757cb6b0d29ec54e93aee  scripts/playground/outcomes.ts
718a6506158c3ef569f8dc2411d2706a1fbc6c617b8756ddddad48b5a75bfe32  scripts/playground/prepare.ts
86fabfe6f52a2f45d384736ab15fc3f1538a47de335e6adb2de3beb74fae2da2  scripts/playground/provider.ts
65f2923fa8b1f26b3bce33afdbe8711e6050784757b06e3deeba825c726f7026  scripts/playground/repository.ts
7a11e6c61f9185ac8bf8ca864a3b6548bcedf9dd471a7ce23538c513387ef5ec  scripts/playground/run.ts
d98d94bc915ba77fc8b16cf83f23417f0d010022b49782ce12afff7d51497d5f  scripts/playground/runtime-limit.ts
2abf39040239a6da49d181538efbb3337c27def57fd47c23fc9ce929f7f92ea7  scripts/playground/stack.ts
```
