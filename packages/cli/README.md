# Loopy CLI

Local-first workflow runtime CLI. Install the packed artifact with Bun:

```sh
bun add ./loopy-0.1.0.tgz
loopy --help
```

The package ships the compiled CLI and its built Studio bundle. It does not
ship project state, fixtures, credentials, or `.loopy` databases.

`loopy ui` starts a loopback-only API and serves a built Studio bundle when the
bundle is present. The bearer token is handed to the browser through an
ephemeral bootstrap global and is never placed in a URL or persistent storage.

`loopy providers --json` reports the four registered adapters (Codex, Claude
Code, OpenCode, and Pi), their installed availability, and capability matrix.
The command only probes version availability; it never starts an agent.

Workflow execution remains deterministic/local by default. To explicitly run a
workflow through an installed adapter, use `loopy run <workflow-id>
--provider <id> --live`. The selected provider must match every agent node in
the workflow and must pass its availability probe; there is no live fallback.

From the repository, `bun run --cwd packages/cli smoke:package` packs the CLI,
installs that tarball into a temporary project, and verifies the installed UI
bundle and authenticated API boundary.

## Project lifecycle and traces

`loopy init` creates `.loopy/config.json` (only when absent) and initializes the
existing local SQLite state. It is safe to run repeatedly. Runtime controls
operate on an existing run ID and use the runtime's legal transitions:

```sh
loopy pause <run-id>
loopy resume <run-id>
loopy cancel <run-id> [--reason "..." ]
loopy retry <run-id> --node <node-id> [--input '{"key":"value"}']
```

Traces use the versioned canonical JSONL codec and SQLite trace sink. Export is
deterministic and can write a file; import validates the complete input before
persisting its events:

```sh
loopy trace export <run-id> --output trace.jsonl
loopy trace import trace.jsonl
```
