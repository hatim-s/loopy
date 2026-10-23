# Native fixture isolation

The test boundary fix is complete on `cloud-integration`, starting at HEAD
`6ffecdfd60e16aaa335467684d918b3cd8b44813`. Scoped verification passed 106 tests
across 15 files with a synthetic ancestor registry and isolated homes. Production
discovery and sandbox behavior were not changed. The full check remains the root
agent's gate.

## Production discovery, unchanged

`packages/loopy/src/local/registry.ts` owns the behavior described here.
`Registry(home, cwd)` calls `projectRoot(cwd)` during construction.

1. Canonicalize `cwd` and inspect that directory.
2. Return the first directory whose `.loopy/loopies` path exists.
3. Otherwise continue through its parents to the filesystem root.
4. If no marker exists, return the canonical original `cwd`.

The existence check does not distinguish a global-home registry directory from a
project marker. For example, a global home at `/synthetic/ancestor/.loopy` creates
`/synthetic/ancestor/.loopy/loopies`, which also qualifies as an ancestor project
marker. The constructor's explicit `home` controls global lookup and artifact
storage. It does not bound `projectRoot`'s ancestor search.

This matters before the first save. An unmarked temporary workspace can inherit
an ancestor project directory during construction. Creating a marker as a side
effect of a later save cannot change that already selected project. Merely
creating the workspace directory or `.loopy` is insufficient. Tests must create
their own `.loopy/loopies` boundary first.

These edits establish test boundaries only. They do not change discovery for real
workspaces or make global-home and project markers distinguishable.

## Test changes and caller audit

- `registry.test.ts` marks both the fixture root and its nested project before
  construction. The fixture root remains independent of the nested project's
  saves, so the existing global fallback assertions retain their meaning.
- `service.test.ts` marks its common root and its separate multi-workspace root.
  The unrelated `elsewhere` directory also has a marker. Existing A/B and `other`
  project markers were retained.
- `fixtures/executor.ts` marks `workspace` before callers construct Registry or
  compile/save a workflow. This covers `service-input.test.ts`, the compiled
  sequence in `executor.test.ts`, and parsed execution callers.
- `cli-fixture.ts` marks its root before writing author source. Its API/CLI
  callers include `cli.test.ts`, `server.test.ts`, `dashboard-http.test.ts`, and
  the standalone daemon-wake fixture source.
- `dashboard-scale-fixture.ts` marks both the 10k-map and 10k-runs roots before
  compilation or Registry construction.
- `source-artifact.test.ts` marks its root before compile/save callers.
- `dashboard-queries.test.ts` marks the common Registry fixture root.
  Its other temporary databases do not construct Registry.
- `wait-host.test.ts` marks its fixture home, which also serves as its workspace.
- Dashboard `review-data-fixture.ts` marks project A and project B separately.
  Its same-slug schedules and views remain independent. `connection-security.test.ts`
  marks its HTTP fixture root.
- `local-daemon.test.ts` marks its temporary directories before implicit Registry
  construction through the daemon's service.
- `secrets.test.ts` gives the CLI test a marked temporary working directory. Its
  daemon and both CLI subprocesses use that directory. The CLI source path is
  absolute so this test no longer depends on the repository working directory.
- `fixtures/summary-service.ts` already marked A/B before constructing Registry.
  It was inspected and left unchanged. The `Registry` class in
  `cloud-scheduler.test.ts` is an in-memory test implementation, not the native
  filesystem Registry. Cloud/R2 callers do not use native project discovery.
- Standalone compiler fixtures do not construct or save through native Registry.
  They were inspected as compile callers and left unchanged.

The audit searched both test trees for `new Registry`, subclasses, `new LoopyService`,
`compile`, `saveCompiled`, `putLoopy`, `localDaemon`, CLI `--home`, and fixture
creation paths. No native suite ran before the marker audit and edits finished.

The existing concurrent edit in `executor.test.ts` was preserved. This lane did
not edit that file or the summary lane's fixtures. There were no test deletions
or moves. Existing files changed by 31 inserted and 13 deleted lines. The new
45-line invariant test brings the test change to 76 inserted and 13 deleted lines.

## Causal boundary probes

`registry-isolation.test.ts` creates a fresh directory directly under `_tests_`,
with an explicit synthetic home and ancestor marker. It saves a valid sentinel
there. Its deliberate negative control shows that a child without a marker
inherits the ancestor and sees its sentinel. After creating child markers,
Registry selects the child, project saves stay local, a nested caller finds its
project, and a separate fallback project sees only the global save. The ancestor
sentinel bytes remain unchanged. The test removes its whole disposable root.

The scoped suite run used another fresh worktree-local root with these child
process environment values:

```text
HOME=<fresh-root>/process-home
LOOPY_HOME=<fresh-root>/default-home
TMPDIR=<fresh-root>/tmp
```

Before running tests, the runner created `<fresh-root>/.loopy/loopies`, then saved
`ancestor-sentinel` through Registry with an explicit synthetic home. After the
run, the ancestor directory still contained exactly `ancestor-sentinel.json` and
its SHA-256 was unchanged:
`f07b3fe21e70d760480431b94ed7039d8cfd0f77ace57fbf25bdf6793227bdea`.
The isolated default home contained no files. The disposable root was removed.
No personal Registry/state, quarantine, or cleanup receipt was accessed.

## Commands and results

The native suite command executed through Python `subprocess.run` with the
isolated environment above was:

```sh
bun --no-env-file test --timeout 60000 \
  ./packages/loopy/_tests_/registry.test.ts \
  ./packages/loopy/_tests_/registry-isolation.test.ts \
  ./packages/loopy/_tests_/service.test.ts \
  ./packages/loopy/_tests_/service-input.test.ts \
  ./packages/loopy/_tests_/source-artifact.test.ts \
  ./packages/loopy/_tests_/dashboard-queries.test.ts \
  ./packages/loopy/_tests_/wait-host.test.ts \
  ./packages/loopy/_tests_/dashboard-scale.test.ts \
  ./packages/loopy/_tests_/cli.test.ts \
  ./packages/loopy/_tests_/server.test.ts \
  ./packages/loopy/_tests_/dashboard-http.test.ts \
  ./packages/loopy/_tests_/local-daemon.test.ts \
  ./packages/loopy/_tests_/secrets.test.ts \
  ./apps/dashboard/_tests_/connection-security.test.ts \
  ./apps/dashboard/_tests_/review-data.test.ts
```

It printed `106 pass`, `0 fail`, `1390 expect() calls`, and
`Ran 106 tests across 15 files. [30.20s]`. This included the new invariant and the
dashboard tests for independent project A/B schedule behavior.

Both commands below received the exact 13 TypeScript paths in the hash manifest:

```text
bunx --no-install biome check <13 paths>
bunx --no-install eslint <13 paths>
```

Biome printed `Checked 13 files in 19ms. No fixes applied.` ESLint exited zero
with no output. `git diff --check` also exited zero with no output.

Scoped TypeScript validation used `bun --no-env-file -e` to load the repository's
compiler options and create a program with those same 13 entry files and their
imports. The executed JavaScript body was:

```ts
import ts from "typescript";
// files was the explicit 13-path array in the hash manifest below.
const config = ts.readConfigFile("tsconfig.json", ts.sys.readFile);
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, process.cwd());
const program = ts.createProgram(files, parsed.options);
const diagnostics = ts.getPreEmitDiagnostics(program);
console.log(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
  getCanonicalFileName: p => p,
  getCurrentDirectory: ts.sys.getCurrentDirectory,
  getNewLine: () => "\n",
}));
console.log(`Scoped TypeScript: ${files.length} entries, ${diagnostics.length} diagnostics`);
process.exitCode = diagnostics.length ? 1 : 0;
```

It printed `Scoped TypeScript: 13 entries, 0 diagnostics` and exited zero.
This was a scoped program check, not the workspace-wide typecheck or full check.

## Remaining executor TMPDIR limit

Disposable copies of `executor.test.ts` and `fixtures/executor.ts` reproduced the
four named failures. The copied fixture used an explicit worktree-local parent
instead of `tmpdir()`; all workspaces had the project marker fix. No production
source or sandbox rule was changed. The command selected these names:

```sh
bun --no-env-file test --timeout 60000 <disposable-test-copy> \
  --test-name-pattern 'code protocol captures stderr logs|only declared secrets reach bundles|bundle results redact once|bundle success masks secrets printed'
```

With the fixture workspace still inside the worktree, both `/tmp` and a nested
worktree-local runtime `TMPDIR` produced `0 pass`, `4 fail`. In these probes the
bundles returned successful results, but stderr contained additional messages:

```text
error: Cannot read file "<worktree>/": EPERM
error: Cannot read file "<worktree>/tsconfig.json": EPERM
error: Cannot read file "<worktree>/packages/loopy/": EPERM
```

Those messages become stderr log records. They break the exact log assertions
for code protocol capture, declared-secret logs, single-pass redaction, and plain
text secret masking. This is distinct from Registry ancestor discovery. A marker
does not make Bun's ancestor configuration reads permissible in the sandbox.

A second disposable-copy probe, with an unchanged synthetic ancestor sentinel,
tested workspace `tsconfig.json` alone, workspace `package.json` alone, and both
together. Each still produced `0 pass`, `4 fail` with the same denied ancestor
paths. These experimental config files were not added to the real fixtures.
All copied files and their disposable roots were removed.

The current `LocalExecutor` supplies only PATH to a sandbox-mode worker; a full-mode
worker inherits the environment. Thus changing the outer runtime `TMPDIR` alone
does not relocate all sandbox worker staging paths. The copied-fixture experiment
held workspace placement fixed and does not claim that an OS-temporary workspace
was retested in this lane.

Recommendation for the root gate: run legacy suites with their normal OS TMPDIR
after these marker fixes, as in the root's reported earlier 1252-test passing
baseline. That baseline is supplied context, not a new result from this lane.
Do not force all legacy fixture workspaces beneath the repository merely to
isolate Registry. New boundary tests should use explicit worktree-local roots
and isolated homes. Future worktree-local executor fixtures need a separate
solution for Bun's sandbox-denied ancestor lookup. No production sandbox
permission should be widened as part of this test fix.

## Product implication and root decision

An unmarked real workspace below any `.loopy/loopies` directory can inherit that
ancestor under the current discovery contract. A global-home marker can qualify
because it has the same path shape. This mechanism is concrete; its intended
user-facing behavior requires a root decision.

The root can retain ancestor discovery and document explicit project initialization,
or separately design a distinguishable marker or an explicit discovery boundary.
Those options affect production semantics and existing workspace behavior. This
lane selects none of them and makes no production discovery change.

No full check, Docker/cloud operation, commit, delegation, existing-service
operation, or personal-data cleanup ran in this lane. Scoped native tests started
and stopped only their own ephemeral servers and daemons.

## SHA-256 manifest

These are the final test file bytes checked by this lane. Paths are relative to
the worktree. The report itself is excluded to avoid a self-referential hash.

```text
08cc5207b2850ec715251f921092ba2c793a169504b69247d3f9cb6eb2b21a01  packages/loopy/_tests_/registry.test.ts
a219149310cec99a786c3705279c1a7cfdd98c5f3e785c3ee1afb2190e257d81  packages/loopy/_tests_/registry-isolation.test.ts
81c4260307df892b71bf2c1ca9eb1bc532ad2b3cdfa893986543524aa07b4336  packages/loopy/_tests_/service.test.ts
0bf04bd4369094523dc01b299ff335b431bc0621a7de68e4367ec1695b8f6580  packages/loopy/_tests_/fixtures/executor.ts
38f7d3255a59ac1021a6633d5be67fd661b8af997a42fdce5d3f650accd19349  packages/loopy/_tests_/cli-fixture.ts
59e27976dcff3f06a5bea06f4053453de818ad518ea902c108f5509042c472ac  packages/loopy/_tests_/dashboard-scale-fixture.ts
9b30bc9a2ab58eefb5cd7df695495403f0846ffe729faa89212d774498286c91  packages/loopy/_tests_/source-artifact.test.ts
659968165010416479e00fa20ae17dfbbb353b92641b729f4ec6e812216a61ca  packages/loopy/_tests_/dashboard-queries.test.ts
5f8f23f2caec66ff8baf1cfbeb358fc30a87a236e0bc88f9aaade3d5d1ddc38b  packages/loopy/_tests_/wait-host.test.ts
6eb73b4478d91fc6d65b78325f68f52531d4942060f83f2bb8e054dfacf65522  packages/loopy/_tests_/local-daemon.test.ts
aaafa417660f1a26e8ace29bac16cda01f77e8901ed982e4fc54b5def778761a  packages/loopy/_tests_/secrets.test.ts
23bb81feb5d41559387f6739be0129096b7875c70ab99b356921f76a5170e8cd  apps/dashboard/_tests_/review-data-fixture.ts
32665fa61f26f6f06753e0d72c57ce3651758721c1572e2a5fbe41f509dc2fd8  apps/dashboard/_tests_/connection-security.test.ts
```
