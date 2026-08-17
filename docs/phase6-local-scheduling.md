# Phase 6: local scheduling and packaging

Loopy scheduling is local-first. Schedule definitions, durable fire claims,
run links, and retention metadata are stored transactionally in
`.loopy/loopy.db`; SQLite is the source of truth whenever a project database
is available. The platform adapter is limited to generating and removing the
explicit scheduler artifacts it owns.

## CLI

```sh
loopy schedule create --id hourly --workflow <workflow-id> --cron '0 * * * *' \
  --timezone UTC --project . --json
loopy schedule list --project . --json
loopy schedule enable|disable|remove <schedule-id> --project .
loopy schedule fire <schedule-id> --project . --json
loopy schedule tick --project . --json
loopy schedule install <schedule-id> --project . --dir /tmp/loopy-scheduler
loopy schedule uninstall <schedule-id> --project . --dir /tmp/loopy-scheduler
loopy cleanup preview --project . --max-age-days 30 --json
loopy cleanup apply --project . --max-age-days 30 --json
```

`--json` is available for every schedule and cleanup command. `schedule fire`
and `schedule tick` claim work through the SQLite schedule repository and hand
it to the existing runtime scheduler, so the resulting run, attempts, and
events are ordinary Studio-visible records. The JSON file store remains
available only when an embedding explicitly injects it; the normal CLI project
path never silently falls back to it.

## OS artifacts

Artifacts are stable and idempotent. macOS emits a launchd plist. Linux emits
a systemd service and timer plus a cron fallback file. Every artifact has a
stable `dev.loopy.schedule.<id>` label and `loopy-managed:<id>` marker, uses
absolute escaped paths, and invokes `loopy schedule tick` against the project.
Windows is rejected with guidance until a tested Task Scheduler backend exists.

Install and uninstall tests always use a temporary target directory; they do
not touch the user's launch agents, systemd units, or crontab.

## npm package

The package is self-contained: `packages/cli` bundles its workspace imports
into `dist/index.js` during `prepack`. Only `dist/index.js`, the README, and
the package manifest are published. Project fixtures, credentials, and
`.loopy` databases are excluded.

```sh
cd packages/cli
npm pack --pack-destination /tmp
bun add /tmp/loopy-0.1.0.tgz
loopy --version
```

`loopy ui` serves the built Studio and local API from loopback. The launcher
injects a one-time in-memory Studio bootstrap global; the bearer token is not
put in a URL or browser storage. Use `--no-open` for headless environments and
`--json` for a listener-free launch-contract dry run.
