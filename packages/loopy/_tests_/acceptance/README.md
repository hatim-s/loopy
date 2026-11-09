# Local acceptance

Run `bun run acceptance:local` from the repository after a large core or runtime refactor. It runs seven scenarios over six authored loopies through real Bun CLI subprocesses and an owned daemon. It is separate from `bun test` and `bun run check`. Neither this suite nor `bun run acceptance:package` runs in CI, so run them by hand.

The suite uses a fresh `.loopy/acceptance/run-*` directory with its own HOME, Loopy home and project registry marker. It does not read personal Loopy state. The daemon binds port 0. Workloads use local commands and sandboxed code bundles. No global install, cloud, Docker, provider or network workload is needed.

Each entry in `cases.ts` is one record holding its fixture, input, optional step before completion and verification. Add a case by adding a record. The cases verify:

- Command stdout, a compiled command parser, code output, references, both branch choices, skipped branch effects, ordered concurrent map results and executable parallel children.
- A command failing its first attempt and succeeding its second, the persisted execution identity across retry, rescue output and one finally cleanup marker.
- A hook surviving daemon restart with the same wait identity, CLI hook resolution and sleep resumption.
- A separate restart during sleep preserving its deadline, with before and after effects each occurring once.
- Authored terminal failure and invalid declared code output failing with `validation` on attempt 1 despite a retry budget of 3.

Every case checks actual output or persisted error and relevant files. `PASS` means assertions passed, including expected failed workflows. A mismatch exits nonzero and stops admissions. Remaining cases stay `pending` in the report. CLI mutations are never retried after a timeout. CLI subprocesses have 20 second deadlines, HTTP reads have 5 second deadlines and polling has 30 second deadlines. Daemon shutdown allows 5 seconds before killing only its owned child.

The printed evidence directory retains the report, per-case snapshots, pending retry/wait snapshots, CLI stdout/stderr, daemon log, SQLite state, bundles and marker files on success and failure. The report records HEAD, dirty status, diff hash, suite bytes hash, run IDs, pinned revisions, case results and cleanup outcome. Source identity is a working-tree fingerprint, not a clean-commit claim. SIGINT and SIGTERM interrupt the suite fiber, release owned processes and write the report. Failures before fixture preparation or source fingerprinting finishes may have no report.

This proves local Bun, CLI save/run/hook, HTTP reads, SQLite, compilation and native executor behavior. It does not prove cloud adapters, Docker, providers, lease loss, uncertain started-execution recovery, cancellation, SSE replay, schedules, secrets or installed CLI packaging. Restart checks use graceful daemon shutdown while no executable is active. Their marker checks do not establish general exactly-once execution after crashes.

Evidence remains until you remove the specific run directory. Stop owned processes first if a runner was forcibly killed outside its signal handlers.
