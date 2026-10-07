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
  loopy run <slug> [--key value ...]            Run with string trigger inputs
  loopy run <slug> --args input.json            Run with a JSON input file
  loopy run <slug> --input JSON|@file           Run with JSON input
  loopy run <slug> --full                       Run with your full host permissions
  loopy resume <run-id> [--retry-uncertain]      Continue from saved checkpoints
  loopy recover <run-id> --force               Release a run owned by another host
  loopy runs [slug]                             List runs
  loopy inspect <run-id>                        Show inputs, attempts, outputs, and events
  loopy types <cli> [command...] --out file.ts   Generate a typed wrapper from CLI help
  loopy ui [--port ${DEFAULT_PORT}]                        Open a read-only graph and run viewer

  --home <directory>    Local definitions and run database. Default: ~/.loopy/v2
  --cwd <directory>     Workspace for a new run or the viewer. Default: current directory
  --replace            Transfer a saved slug from another source file
  --name <identifier>   Export name for a generated CLI wrapper

Run input: choose named flags, --args, or --input. Named values are strings.
In a terminal, missing named inputs are prompted one at a time before running.
Use --key=value for dash-prefixed values; use -- --key value for reserved names.

Saved TypeScript is trusted code executed during save. Saved graphs contain only data.
Sandbox runs deny network and restrict writes to the workspace. No host fallback.
Retrying an uncertain attempt can repeat a side effect from an interrupted command.
`;
}
