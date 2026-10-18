export function usage(): string {
  return `loopy: compiled workflow graphs for CLI tools

  loopy graph <name|file> [--format json|text]
  loopy save <file.ts> [--replace]            Compile and save a graph
  loopy list                                  List saved loopies
  loopy run <slug> [--key value ...]          Queue with named inputs
  loopy run <slug> --input-json JSON          Run with JSON input
  loopy run <slug> --input-file input.json    Run with input from a file
  loopy runs [slug]                           List runs as JSON
  loopy inspect <run-id>                      Show the snapshot, cursor and epoch
  loopy logs <run-id> [--follow]              Print logs; follow emits NDJSON
  loopy resume <run-id>                       Continue a queued, suspended or abandoned run
  loopy cancel <run-id>                       Cancel a claimable run
  loopy schedule <slug> [set] [--cron EXPR] [--tz ZONE] [--input-json JSON]
  loopy schedule <slug> enable|disable    Toggle its saved schedule
  loopy schedule <slug> off                 Remove its schedule
  loopy daemon run [--concurrency N] [--port 4310] [--lease-ms 60000]          Run the foreground daemon
  loopy daemon install [--concurrency N] [--port 4310]      Install and start the user service
  loopy daemon uninstall                     Remove the user service
  loopy daemon status                        Show daemon PID, port and start time
  loopy types <cli> [command...] --out file.ts [--name identifier]
  loopy secrets set <name> [--stdin]          Store a secret privately
  loopy secrets list                          List secret names
  loopy secrets remove <name>                 Delete a stored secret
  loopy ui [--port PORT]                      Print the dashboard URL, starting the daemon if needed

Global options:
  --home <directory>    Registry, bundles and runs.sqlite. Default: ~/.loopy
  --cwd <directory>     Workspace for a new run. Default: current directory
  --help, -h            Show usage

Choose one input source: named flags, --input-json, or --input-file.
Named inputs coerce numbers and booleans from the loopy's record specification.
In a terminal, missing required record fields are prompted before running.
Use --key=value for dash-prefixed values; use -- --key value for reserved names.

Saving compiles TypeScript in a sandbox. Activation executes the saved graph.
Declare mode and secrets in loopy(). Sandbox runs deny network and restrict writes
outside the workspace. A failed sandbox launch never falls back to full mode.
`;
}
