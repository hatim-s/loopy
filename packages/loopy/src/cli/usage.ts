import { DEFAULT_PORT } from "../local/index.js";

export function usage(): string {
  return `loopy: TypeScript workflows for CLI tools

  loopy save <file.ts>               Bundle a file and save by configured scope
  loopy secrets set <name> [--stdin]           Store a secret through hidden entry or stdin
  loopy secrets list                           List secret names
  loopy secrets remove <name>                  Delete a stored secret
  loopy list                                   List saved loopies
  loopy run <slug>                             Prompt for inputs, then run
  loopy run <slug> [--key value ...]            Run with schema-coerced SDK inputs
  loopy resume <run-id>                       Continue a suspended SDK run
  loopy run <slug> --input-json JSON [--detach] SDK JSON input; detach queues for the daemon
  loopy run hello --name Hatim            Pass named SDK input fields
  loopy run <slug> --input-file input.json     SDK input from a JSON file
  loopy logs <run-id> [--follow]                Show run logs
  loopy cancel <run-id>                        Cancel a claimable run
  loopy schedule <slug> [--cron EXPR] [--tz ZONE] Use the saved schedule or explicit overrides
  loopy schedule <slug> --off                  Remove its schedule
  loopy daemon run [--concurrency N]           Run the foreground daemon
  loopy runs [slug]                             List runs
  loopy types <cli> [command...] --out file.ts   Generate a typed wrapper from CLI help
  loopy ui [--port ${DEFAULT_PORT}]                        Open a read-only step trace and log viewer

  --home <directory>    Local definitions and run database. Default: ~/.loopy/v2
  --cwd <directory>     Workspace for a new run or the viewer. Default: current directory
  --replace            Transfer a saved slug from another source file
  --name <identifier>   Export name for a generated CLI wrapper

Input: choose named flags, --input-json, or --input-file. Legacy runs use --args or --input.
In a terminal, missing named inputs are prompted one at a time before running.
Use --key=value for dash-prefixed values; use -- --key value for reserved names.

Saved TypeScript is trusted code executed during save and SDK activation.
SDK named inputs coerce numbers and booleans from their record spec.
Sandbox runs deny network and restrict writes to the workspace. No host fallback.
`;
}
