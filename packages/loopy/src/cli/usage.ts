import { DEFAULT_PORT } from "../local/index.js";

export function usage(): string {
  return `loopy: TypeScript workflows for CLI tools

  loopy save <file.ts|directory>               Compile files and save by configured scope
  loopy secrets set <name> [--stdin]           Store a secret through hidden entry or stdin
  loopy secrets bind <slug> <ENV> <name>        Grant a workflow access to a secret
  loopy secrets unbind <slug> <ENV>             Revoke a binding
  loopy secrets bindings <slug>                List a workflow's bindings
  loopy secrets list                           List secret names
  loopy secrets remove <name>                  Delete a stored secret
  loopy list                                   List saved loopies
  loopy graph <slug>                            Print the saved graph as JSON
  loopy run <slug>                             Prompt for inputs, then run
  loopy run <slug> [--key value ...]            Run with schema-coerced SDK inputs
  loopy legacy:run <slug> --args input.json     Run a legacy graph with a JSON input file
  loopy legacy:run <slug> --input JSON|@file    Run a legacy graph with JSON input
  loopy legacy:run <slug> --full                Run a legacy graph with full host permissions
  loopy resume <run-id>                       Continue a suspended SDK run
  loopy recover <run-id> --force               Release a run owned by another host
  loopy run <slug> --input-json JSON [--detach] SDK JSON input; detach queues for the daemon
  loopy run hello-sdk --name Hatim            Pass named SDK input fields
  loopy run <slug> --input-file input.json     SDK input from a JSON file
  loopy logs <run-id> [--follow]                Show engine logs
  loopy cancel <run-id>                        Cancel a claimable engine run
  loopy schedule <slug> [--cron EXPR] [--tz ZONE] Use the saved schedule or explicit overrides
  loopy schedule <slug> --off                  Remove its schedule
  loopy daemon run [--concurrency N]           Run the foreground daemon
  loopy legacy:resume <id> --retry-uncertain   Retry an uncertain legacy attempt
  loopy legacy:<command>                      Use the original graph command
  loopy runs [slug]                             List runs
  loopy inspect <run-id>                        Show run, steps and logs; legacy attempts and events
  loopy types <cli> [command...] --out file.ts   Generate a typed wrapper from CLI help
  loopy ui [--port ${DEFAULT_PORT}]                        Open a read-only graph and run viewer

  --home <directory>    Local definitions and run database. Default: ~/.loopy/v2
  --cwd <directory>     Workspace for a new run or the viewer. Default: current directory
  --replace            Transfer a saved slug from another source file
  --name <identifier>   Export name for a generated CLI wrapper

SDK input: choose named flags, --input-json, or --input-file. Legacy runs use --args or --input.
In a terminal, missing named inputs are prompted one at a time before running.
Use --key=value for dash-prefixed values; use -- --key value for reserved names.

Saved TypeScript is trusted code executed during save and SDK activation.
SDK definitions are bundled; legacy graphs contain only data.
SDK named inputs coerce numbers and booleans from their record spec.
Sandbox runs deny network and restrict writes to the workspace. No host fallback.
Retrying an uncertain attempt can repeat a side effect from an interrupted command.
`;
}
