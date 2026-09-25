# Loopy

Write local CLI workflows in TypeScript. Save them by slug, run them in a sandbox or with full permissions, and inspect their graph and execution history.

The local CLI and adapters require Bun 1.4 or newer. Workflow authoring, orchestration and the cloud worker use standard JavaScript and web APIs. One public package exposes separate concern boundaries; Studio remains the only other workspace package.

## Try this checkout

```sh
bun install
bun run check
bun run build
bun run loopy save examples/hello.loopy.ts
bun run loopy run hello --input '{"message":"hello from TypeScript"}'
bun run loopy ui
```

Open the URL printed by `loopy ui`. Its fragment contains a local session token. The viewer lists saved workflows, shows commands and branches, runs workflows, and inspects inputs, outputs, events and resume state. Edit the TypeScript file or ask an agent to edit it, save it again, then use Refresh in the viewer.

For a project using the built package, install its packed archive with `bun add /path/to/loopy-0.3.0.tgz`. The package provides both `import ... from "loopy"` and `bunx loopy`.

## Author a loopy

```ts
import { command, contains, node, trigger } from "loopy";

export default trigger<{ message: string }>("hello")
  .node("echo", ({ input }) => command("printf", "%s", input.message))
  .node("count", ({ steps }) => ({
    ...command("wc", "-c"),
    stdin: steps.echo.stdout,
  }))
  .condition(
    "greeting",
    ({ steps }) => contains(steps.echo.stdout, "hello"),
    node("welcome", command("printf", "%s", "Welcome")),
    node("other", command("printf", "%s", "Message recorded")),
  );
```

Command arguments are separate argv values. Shell expansion, pipes and interpolation do not happen. Use `stdin` to pass an earlier result to another command. Every command produces `stdout`, `stderr`, `exitCode` and `durationMs`. A nonzero exit stops the run and keeps its output.

Callbacks run once during authoring with typed references. Use `concat`, `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `and`, `or`, `not` and `contains` to build expressions. Ordinary JavaScript conditionals on references do not describe runtime branches. `at(reference, key)` addresses a nested input property. Branches accept a node, an array of nodes, or a callback returning either. Step IDs are unique across the graph. Branch-local outputs are deliberately unavailable after the branch; the condition exposes `steps.conditionId.branch`.

TypeScript input types check authoring code. At execution, references must exist and values must match the operation or command argument they feed. This is not a generated JSON schema for the entire trigger input.

The low-level `command(program, ...args)` accepts arbitrary CLI arguments. For checked flags and positional arguments, generate a wrapper.

## Generate typed CLI commands

```sh
bunx loopy types codex exec --out ./tools/codex.ts
```

```ts
import { trigger } from "loopy";
import { codexExec } from "./tools/codex.ts";

export default trigger<{ prompt: string }>("review")
  .node("review", ({ input }) => codexExec({
    args: [input.prompt],
    flags: { json: true, sandbox: "read-only" },
  }));
```

The generator executes `<cli> <command...> --help`, records its hash and the observed CLI version, and emits one command descriptor. TypeScript infers the wrapper's positional tuple, flag names, value types and documented choices from that descriptor. Unknown flags fail typechecking and runtime construction. Saved graphs retain value constraints so resolved run inputs are checked before launching the command. No CLI command runs while the workflow is compiled.

Wrappers insert `--` before positional arguments so a leading dash in input cannot become another option. For tools that do not support this separator, set `positionalSeparator: false` on the descriptor and validate option-like inputs yourself. Optional flags documented as `--flag[=<VALUE>]` retain their attached-value syntax.

Help formats vary. The generator reports omitted or ambiguous syntax and does not discover every subcommand automatically. Generate a wrapper for each command path you need. A descriptor can specify `repeatable: true`, numeric values or choices when the help text leaves those unclear. The saved hash records what was observed; Loopy does not enforce an installed CLI version on every run. Regenerate wrappers after upgrading a CLI.

`examples/codex.ts` was generated from the installed CLI. `examples/review.loopy.ts` shows how to use it. A networked agent CLI generally needs `--full` under the current network-denying sandbox policy.

## Run and resume

```sh
loopy save ./review.loopy.ts
loopy list
loopy graph review
loopy run review --input @input.json --cwd /path/to/repo --full
loopy runs review
loopy inspect <run-id>
loopy resume <run-id>
loopy resume <run-id> --retry-uncertain
loopy recover <run-id> --force
```

Saving imports trusted TypeScript on the host and writes a validated JSON graph. Only save code you trust. Running reads that graph and snapshots it alongside the input, working directory and execution mode. Saving a new definition never changes an existing run.

SQLite commits a running attempt before launching its command, then commits its completion and output together. Resume skips completed commands and retries failed commands. Dead owners are recovered on opening or reading the store. A crash, cancellation, timeout or output-limit termination after a command starts leaves an uncertain attempt. Resuming it requires `--retry-uncertain`, because an external side effect may already have happened. CLI side effects are not exactly once. A live owner prevents concurrent execution of the same run.

After a hostname change or moving the database to another machine, `loopy recover <run-id> --force` releases a foreign owner's claim and marks any in-flight attempt uncertain. Stop the original runner first. Recovery prevents its later database writes, but cannot stop a command on another host. Resume still requires explicit retry of uncertain work.

Runs execute sequentially with nested conditions. This version does not provide parallel execution, scheduled triggers, automatic retries, cycles, approval nodes or replay forks. Those can be added against concrete workflow needs without reviving the old provider and trace layers.

State defaults to `~/.loopy/v2`, with `workflows/<slug>.json` and `runs.sqlite`. Set `LOOPY_HOME` or pass `--home` for a different data directory. Run records retain resolved argv, stdin, explicit environment, stdout and stderr. Avoid putting credentials in those values unless you intend to store them locally. Old Loopy databases are left untouched.

## Execution permissions

Sandbox is the default and never falls back to full permissions. On macOS it uses `sandbox-exec`; on Linux it requires `/usr/bin/bwrap`. Unsupported systems or unavailable backends fail the run before unrestricted execution.

The sandbox allows writes inside the chosen workspace and denies network access. It masks or denies home-directory reads outside the workspace and the executable's package. System files and readable paths outside the home remain readable, so this is not a confidentiality boundary for all host files. Use a narrow workspace directory. Linux uses separate namespaces and a private temporary directory. CI exercises Linux confinement on Ubuntu 22.04 with bubblewrap. Hosts that block unprivileged namespaces cannot use this backend; execution fails closed.

`--full` runs with the current user's filesystem, environment and network access. Both modes enforce a five-minute default timeout and an eight-MiB combined output limit. Set `timeoutMs` and `maxOutputBytes` on a command to change them. Sandbox launchers receive a clean environment; explicit command variables are applied inside confinement.

Cancellation and completion stop the command's process group. Commands that deliberately create separate sessions can escape group cleanup, and hard-killing Loopy can leave a child alive. Daemonizing commands are unsupported. Output pipes close after a bounded drain period so escaped descendants cannot keep Loopy waiting indefinitely. Inspect remaining processes and external effects before retrying uncertain work.

For existing Bash scripts, `bash(script)` is an explicit escape hatch with the same execution policy. The normal API never requires a shell script.

## Development

```sh
bun run check       # Typecheck and core runtime/product tests
bun run fmt:check
bun run build       # Build and bundle the readonly viewer
bun run loopy ui
```

## Architecture and cloud readiness

| Import | Owns | Depends on |
| --- | --- | --- |
| `loopy` | Typed workflow authoring, command descriptors, graph model and validation | Standard JavaScript |
| `loopy/runtime` | Async orchestration, repository contract and execution errors | Core and injected adapters |
| `loopy/local` | SQLite, filesystem registry, trusted TypeScript loading, CLI-help discovery, sandbox processes and local server | Core, runtime, Bun and the OS |
| `loopy/cloud` | Queue-delivery validation and worker entry point | Core and runtime contracts |
| CLI executable | Arguments and local composition | Local adapters |

`Runtime` takes a `RunRepository` and an `ExecuteCommand`. It does not open a database, access the filesystem or launch processes. Its create, execute and read methods return promises. The caller owns adapter cleanup. Each executor invocation receives `runId`, `nodeId`, `attemptId` and `ownerToken` for correlation and remote dispatch deduplication.

```ts
import { createLocalRuntime, localRunOptions } from "loopy/local";

const local = createLocalRuntime({ home: "./.loopy" });
try {
  const run = await local.runtime.createRun(
    workflow.build(), input, localRunOptions(process.cwd(), "sandbox"),
  );
  await local.runtime.execute(run.id);
} finally {
  local.close();
}
```

Local workspaces are `{ kind: "local", path }`; managed workspaces are `{ kind: "managed", id }`. Only the local adapter canonicalizes host paths. A hosted executor resolves managed workspace IDs and applies its own isolation, environment, secret and network policy. An edge environment can run orchestration, but CLI execution still needs an OS-backed runner.

```ts
import { Runtime, type RunRepository, type ExecuteCommand } from "loopy/runtime";
import { CloudWorker } from "loopy/cloud";

export function worker(store: RunRepository, executor: ExecuteCommand) {
  return new CloudWorker(new Runtime({ store, executor }));
}
// Deliver { runId } only after that run has been durably created.
// Acknowledge outcome.disposition === "ack"; retry "retry" or infrastructure errors.
```

Cloud delivery is for initial execution. It atomically leaves succeeded, failed and interrupted runs unchanged, even when deliveries race. Resuming a terminal run is a separate explicit `Runtime.execute` operation. Retrying uncertain work additionally requires `retryUncertain: true`. Do not put a reusable retry permission on a queue message: redelivery could otherwise authorize a new uncertain attempt without another decision.

The repository contract requires atomic attempt/event transitions and owner-token fencing. Distributed implementations must use bounded leases and atomic expired-owner recovery; the local SQLite adapter uses host process liveness. Expired work becomes uncertain, and old tokens cannot commit. The runtime serializes async heartbeats, checks ownership before launch, and treats unknown executor transport errors as uncertain. Adapters must bound network calls and honor the abort signal. A database fence cannot stop a command already running on another machine.

This refactor does not deploy a cloud service. Before hosting, implement tenant-scoped authorization and storage, durable dispatch with an outbox or pending-run reconciliation, workspace provisioning, and an isolated command runner. The local server's in-memory job set and loopback session token are local conveniences, not cloud queue or authentication implementations. The portable build and browser bundle check enforce the dependency boundary.

Stop older Loopy processes before opening existing data with 0.3. SQLite migration converts v1 `cwd` options to local workspace references once and preserves snapshots, attempts and events. The upgraded database is v2; older binaries cannot reopen it.

The local server binds to loopback, checks host and origin, and requires its session token for every API request.

The viewer serves a fixed copy of its assets loaded at startup and excludes symlinks. Workflow writes cannot replace the JavaScript of an already running viewer. As with any workspace code, inspect package or source changes before starting another trusted Loopy process.

The source modules keep the boundaries small: workflow compilation, command typing/help parsing, process execution, run storage/runtime, local registry, and CLI/HTTP adapters. The rebuild removes the old extraction, trace-import, visual-editing, provider, tool-installer, scheduler, MCP-edit and worktree packages.
