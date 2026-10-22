# Real Docker transport proof

Passed on 2026-10-22, 17:24:04 through 17:24:25 UTC. Machine-readable evidence is [evidence/transport-failure.json](evidence/transport-failure.json).

Identity was initially verified at the requested `cloud-integration` HEAD `8eb76408294968abb4bb9e41cbffc1104e1f814b`. The parent advanced HEAD to `214bbe3910ff65dc3eec6af31c187908e33246bc` during preparation. That commit changes only `.notes/cloud` documentation and screenshots. The fixture checks ancestry, permits only cloud notes, the local runbook and its own harness files after the requested commit, rejects other committed runtime changes, and compares source hashes before and after execution. The parent widened the original notes-only guard so committing this harness does not prevent rerunning it.

Run from `/Users/hatim.shakir/projects/loopy/cloud-integration`:

```sh
env -i PATH="$PATH" HOME="$HOME" LANG=C.UTF-8 bun --no-env-file scripts/cloud/transport-failure.ts
```

Both scenarios printed `status: passed` and the command exited 0. Every run uses a fresh directory below `.loopy/cloud-transport`, with the provider's validated nested state-root layout. No listener is started. The shared fixture ports and services were untouched. Standard service tier was verified; no delegation, production edits, image rebuild, daemon stop, default-context change, remote action, push or commit occurred.

- `kill_wait_client`: an actual `docker --context colima-loopy-cloud-phase1 wait <receipt.container>` child was observed in flight, then killed with SIGKILL. Its real exit code was 137. Independent inspections confirmed the exact labelled worker remained running before and after the client kill. Subsequent inspect and fallback list invocations received real Docker connection errors through the isolated socket fault. The receipt stayed started; recovery joined the original container and read success. Its workspace contained exactly `started\nfinished\n`.
- `unavailable_inspect_socket`: the existing `CommandRunner` parameter executes only selected inspect/list calls with `--host unix:///var/empty/loopy-transport-<owner-prefix>.sock`. The actual CLI returned exit code 1 and a missing-socket connection error while independent calls through the named context confirmed the worker remained running. The service object was closed and reconstructed after 1.2 seconds. Recovery retained the original container ID, start time, receipt ID, attempt 1 and absolute deadline. It issued one kill and persisted the timeout result 187 ms after that deadline. The workspace contained exactly `started\n`.

Each scenario asserted one admission, one worker create and one start despite two duplicate admissions during the fault, one after restoration and one after completion. Cleanup used only exact names from the durable receipt, checked owner/request labels before removal, and verified both recorded volumes absent. Across both scenarios, two workers and four volumes were removed. Staging and artifact helpers were already absent. No owned containers, receipt-derived volumes, wait-client processes, active runner calls or service locks remained. Receipts remain on disk for inspection.

Verification commands, all exited 0:

```sh
bunx --no-install biome check scripts/cloud/transport-failure*.ts .notes/cloud/evidence/transport-failure.json
bunx --no-install eslint scripts/cloud/transport-failure*.ts
bunx --no-install tsc --noEmit
env -i PATH="$PATH" HOME="$HOME" LANG=C.UTF-8 bun --no-env-file test --timeout 60000 packages/loopy/_tests_/cloud-sandbox.test.ts
git diff --check
```

Biome checked five files without fixes. ESLint and TypeScript were silent. Existing sandbox boundary tests reported 12 passed, one opt-in Docker test skipped, zero failed, 115 assertions. The separate transport command supplies the real Docker evidence here. No test was deleted or moved. The repository-wide build/check was not repeated during the parent's browser work.

The prebuilt image ID is `sha256:f99137d238871c84887617777c81e9920f4fcff3f9e3cb9c07d49e66c20b1cc8`. Its actual `/opt/loopy/worker.js` SHA-256 was `55f2fcb8fbc0d1c9fc4918a77b83e8ff2d629197ca6a45af50beba3bed8c3361` in both workers. Host source hashes include `attempts.ts` = `d5da615824d59074e123440f7155d551090195c0b04021d7d8d2ced2245f12ac` and `docker.ts` = `879d257ccec1c61fb2acddf004ccf29aa97c34bb878e830fc4227278bcfd46be`. Full sandbox, process, contract and fixture hashes are in the JSON and were unchanged during execution.

The failure is injected by choosing which real CLI child to kill or which endpoint selected CLI invocations use. Docker results and container state are not mocked. The healthy daemon remains available, and reconstruction happens within one test process. This proves local provider recovery from these CLI failures; it does not prove daemon failure, a network partition, an OS process crash, remote durability or Modal parity. The existing image was not rebuilt, so host-source hashes do not independently prove its build provenance. No causal production bug was found.

Preparation included two failed preflight checks before any Docker fixture ran: a lint error in the new timeout helper, then the intentional HEAD guard rejecting the parent's documentation commit. Both were corrected before the single passing Docker execution.

## Parent verification

The parent reran the corrected harness at 17:27:30 through 17:27:51 UTC on 2026-10-22. Both scenarios passed; the second timeout completed 134 ms after its original deadline. The JSON now records this rerun and the corrected harness hash. An independent read-only Docker check confirmed zero containers with either owner label and all four receipt-derived volumes absent. No runtime implementation changed.

## Reproducible later runs

The historical commit whitelist was removed when the separate Modal preparation was added. Each run now records the actual HEAD, verifies the exact integration worktree and branch, and compares all sampled runtime and harness source hashes plus the image ID before and after execution. Earlier evidence remains tied to its recorded snapshot. A later run verifies its own source snapshot rather than claiming the original source is unchanged.
