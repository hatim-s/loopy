import { DEFAULT_PORT } from "../local/index.js";

export function usage(): string {
  return `loopy: replayable TypeScript workflows for CLI tools

  loopy save <file.ts> [--replace]             Bundle and register a loopy
  loopy list                                  List saved loopies
  loopy run <slug> [--key value ...]           Run with named inputs
  loopy run <slug> --input-json JSON           Run with JSON input
  loopy run <slug> --input-file input.json     Run with input from a file
  loopy run <slug> [--detach]                  Queue for the daemon instead of running inline
  loopy runs [slug]                            List runs
  loopy inspect <run-id>                       Show the run, step trace and logs
  loopy logs <run-id> [--follow]               Print logs; follow emits NDJSON
  loopy resume <run-id>                       Continue a queued or suspended run
  loopy cancel <run-id>                       Cancel a claimable run
  loopy schedule <slug> [--cron EXPR] [--tz ZONE] [--input-json JSON]
  loopy schedule <slug> --off                 Remove its schedule
  loopy daemon run [--concurrency N]          Run the foreground daemon
  loopy types <cli> [command...] --out file.ts [--name identifier]
  loopy secrets set <name> [--stdin]          Store a secret privately
  loopy secrets list                          List secret names
  loopy secrets remove <name>                 Delete a stored secret
  loopy ui [--port ${DEFAULT_PORT}]                       Open Studio's read-only run viewer

Global options:
  --home <directory>    Registry, bundles and runs.sqlite. Default: ~/.loopy/v2
  --cwd <directory>     Workspace for a new run or Studio. Default: current directory
  --help, -h            Show usage

Choose one input source: named flags, --input-json, or --input-file.
Named inputs coerce numbers and booleans from the loopy's record specification.
In a terminal, missing required record fields are prompted before running.
Standard Schema inputs require --input-json or --input-file.
Use --key=value for dash-prefixed values; use -- --key value for reserved names.

Saved TypeScript is trusted code executed during save and activation.
Declare mode and secrets in loopy(). Sandbox runs deny network and restrict writes
outside the workspace. A failed sandbox launch never falls back to full mode.
`;
}
