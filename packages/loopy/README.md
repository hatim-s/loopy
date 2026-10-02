# Loopy

Write CLI workflows in TypeScript. Save them by slug, run them in a sandbox or with full permissions, and inspect the graph and every attempt afterwards.

Needs Bun 1.4 or newer. The authoring API, the runtime and the cloud worker are plain JavaScript modules with type declarations; only the local adapters and the CLI touch Bun and the OS.

## Try it

```sh
bun install
bun run check
bun run build
bun run loopy save examples/hello.loopy.ts
bun run loopy run hello --input '{"message":"hello from TypeScript"}'
bun run loopy ui
```

`loopy ui` prints a URL with a session token in the fragment. The viewer lists saved workflows, draws the graph, starts runs and shows inputs, outputs, events and resume state. Edit the TypeScript, save again, hit Refresh.

## Install globally

```sh
bun install
bun run install:global
loopy --help
```

This builds and packs the package into `~/.loopy/packages/loopy-<sha256>.tgz` and installs it with `bun add --global`. Put the directory from `bun pm bin -g` on your PATH. Rerun after pulling. The installer also prints a `bun add <archive>` command for projects that import `loopy`; the global CLI does not provide that dependency.

Run `loopy --version` to see the installed package version, Git revision, whether the build included uncommitted changes, and the SHA-256 of its built files. `loopy doctor` compares the project's authoring package with the CLI and reports saved registrations in the wrong scope, including legacy global registrations hidden from `list`. It does not import workflow source or change saved data.

Use `loopy doctor <slug> --cwd /path/to/workspace` to check command directories, executable lookup and missing absolute file arguments. Missing files are warnings because an argument may name a new output destination. Conditional commands are advisory until the run selects a branch. Doctor checks host paths; it does not prove sandbox access or validate arbitrary script input.

Keep `*.loopy.ts` files next to the code they automate, or in one loopies project with its own `loopy` dependency:

```sh
loopy save /path/to/repo/loopies --cwd /path/to/repo
loopy list
cd /path/to/another/repo
loopy run review --full
```

Folder saves walk the tree for `*.loopy.ts`, skipping hidden entries, symlinks, `node_modules`, `dist` and `coverage`. Every file is imported and checked before anything is written. Two files with the same slug fail the whole save, `--replace` or not; rename one. A slug already owned by a different source fails unless you pass `--replace`.

Legacy global registrations saved before workflow scopes may be hidden from `loopy list`. Run `loopy migrate --dry-run` to list them without importing source or changing data. Edit each owner source to declare `.config({ scope: "global" })` or `.config({ scope: "project" })`, then run `loopy migrate <slug> --apply`. Apply imports that trusted source and migrates one registration. Global paths become absolute references to existing locations; project registrations move beside their source project. Migration preserves source ownership, refuses slug collisions, and never edits source or copies dependencies. Restore a missing source before applying its migration.

Workflows default to project scope. Project graphs live in `<project>/.loopy/workflows` and are available from that directory and its children. `loopy save` uses the current project directory for sources inside it, or the source directory for external sources; pass `--cwd /path/to/project` to select another project. Only workflows configured with global scope are saved to `~/.loopy/v2/workflows` and available everywhere. A project slug overrides a global slug of the same name.

```ts
import { command, file, trigger } from "loopy";

export default trigger("review")
  .config({ scope: "global" })
  .node("review", command("bun", file("scripts/review.ts")));
```

Use `.config({ scope: "project" })` for explicit project scope. Saving snapshots the JSON graph. Global saves convert `file(...)`, standalone argv and env strings starting with `./` or `../`, relative executable paths, and explicit command `cwd` into absolute paths. Paths resolve against the workflow source directory, or its explicit command `cwd`. Use `file("scripts/review.ts")` for paths without a leading `./`, including paths inside `concat` expressions. Marked paths in expressions, stdin, and conditions are resolved too. Plain expression fragments and shell script text are not rewritten. CLI executables such as `bun` still resolve through PATH.

Global scripts, assets, or command directories outside the sandbox workspace may require `loopy run <slug> --full`. Global scope does not change sandbox permissions.

Referenced scripts and assets stay in their source locations. Editing them affects later runs; moving or deleting them can break a saved global workflow. Changing scope and saving removes the same source's old registration. Older graphs in global storage need to be saved again with explicit global scope.

Running a slug never imports TypeScript. Commands run in the caller's current directory or `--cwd`, unless a command sets its own `cwd`.

For syncing www agent prompts and skills into uacode, see [the www-to-uacode example](https://github.com/hatim-s/loopy/tree/main/examples/www-uacode-sync).

## Author a workflow

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

Arguments are separate argv entries. No shell, no expansion, no pipes. Pass an earlier result to `stdin` instead. Every command yields `stdout`, `stderr`, `exitCode` and `durationMs`; a nonzero exit stops the run and keeps the output.

Callbacks run once, at authoring time, with typed references rather than values. `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `and`, `or`, `not`, `contains` and `concat` build expressions the runtime evaluates later; a plain JavaScript `if` on a reference does nothing useful. `at(reference, key)` reaches into nested input. Branches take a node, an array of nodes, or a callback returning either. Node ids are unique across the graph, and a branch's outputs are not visible after the branch; use `steps.<conditionId>.branch` instead.

The `Input` type parameter checks your authoring code. At run time, references must exist and values must fit the operation or argument they feed. Nothing generates a JSON schema for the whole input.

`command(program, ...args)` takes anything. For checked flags and positionals, generate a wrapper.

## Generate a typed wrapper

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

The generator runs `<cli> <command...> --help`, hashes the output, records `--version`, and writes one `CommandDescriptor`. TypeScript infers the positional tuple, flag names, value types and documented choices from it. Unknown flags fail both the typecheck and the call. The saved graph keeps the constraints, so a run input that violates them fails before the command launches.

Wrappers put `--` before positionals so input starting with a dash cannot become a flag. For tools that reject `--`, set `positionalSeparator: false` on the descriptor and validate dash-prefixed input yourself. Flags documented as `--flag[=<VALUE>]` keep the attached form.

Help formats vary. The generator warns about lines it could not parse and only covers the one command path you asked for. Hand-edit the descriptor when the help is vague about repeatable flags, numbers or choices. The hash is a record of what was seen, not a runtime check; regenerate after upgrading a CLI.

`examples/codex.ts` was generated from the installed Codex CLI and `examples/review.loopy.ts` uses it. Agent CLIs need the network, so run those with `--full`.

The [uacode asset sync example](https://github.com/hatim-s/loopy/tree/main/examples/uacode-asset-sync)
uses a current TypeScript graph and an isolated worktree runner to export assets and open a focused PR.

## Run, resume, recover

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

Slugs are scoped to a project directory or the global Loopy home. `loopy list` shows which source owns each one. Saving the same file again updates the graph; a different file with the same slug fails until you rename it or pass `--replace`. Symlinked sources resolve to their real path. Saves take a per-slug lock directory and rename the new file into place; if a save dies mid-way, remove the lock it names once you're sure the process is gone.

Saving imports and executes your TypeScript. Only save code you trust. Running snapshots the graph, input, working directory and mode into the run, so later saves never change an in-flight or finished run.

Each attempt is committed as running before the command launches, then its result and output are committed together. Resume skips succeeded commands and reruns failed ones. If Loopy crashes, is cancelled, times out or hits the output limit after a command started, that attempt is uncertain: the side effect may or may not have happened. Resuming past it needs `--retry-uncertain`. Nothing here is exactly-once. A live owner blocks a second execution of the same run.

`loopy recover <run-id> --force` is for a database that moved hosts or a hostname that changed. It strips the foreign owner's claim and marks any in-flight attempt uncertain. Stop the other runner first; recovery blocks its later writes but cannot kill its process.

Runs are sequential with nested conditions. No parallelism, schedules, automatic retries, cycles, approvals or forks yet.

Global graphs and run state live in `~/.loopy/v2` (`workflows/<slug>.json` and `runs.sqlite`); project graphs live in `<project>/.loopy/workflows`. set `LOOPY_HOME` or pass `--home` to move it. Run records keep resolved argv, stdin, explicit env, stdout and stderr, so don't pass credentials through them unless you want them on disk.

## Sandbox

Sandbox is the default and never falls back to full permissions. macOS uses `sandbox-exec`; Linux needs bubblewrap at `/usr/bin/bwrap` or `/bin/bwrap`. Anything else fails the run.

Inside the sandbox a command can write to the workspace and nowhere else, and has no network. Reads of your home directory outside the workspace (and outside the executable's own package) are denied. Everything else readable on the host stays readable, so pick a narrow workspace. Linux additionally unshares namespaces and gets private `/tmp` and `/run`. CI runs the Linux tests on Ubuntu 22.04; hosts that forbid unprivileged namespaces fail closed.

`--full` runs as you, with your environment and network. Both modes default to a five-minute timeout and eight MiB of combined output; set `timeoutMs` and `maxOutputBytes` per command to change that.

Loopy runs each command in its own process group and kills the group on timeout, cancel and exit. A command that starts its own session can outlive that; so can a child of a hard-killed Loopy. Daemons are unsupported. Output pipes close after a short drain so a straggler cannot hang the run. Check for leftover processes before retrying uncertain work.

`bash(script)` exists for scripts you already have. It runs under the same policy as everything else.

## Architecture

| Import | Owns | Depends on |
| --- | --- | --- |
| `loopy` | Authoring API, command descriptors, graph model and validation | Nothing host-specific |
| `loopy/runtime` | `Runtime`, the `RunRepository` contract, execution errors | `loopy` and injected adapters |
| `loopy/local` | SQLite store, file registry, TypeScript loading, help parsing, sandboxed processes, HTTP server | Bun and the OS |
| `loopy/cloud` | `CloudWorker`, which validates queue messages and dispatches runs | `loopy/runtime` |
| CLI | Argument parsing and wiring the local pieces together | `loopy/local` |

`Runtime` takes a `RunRepository` and an `ExecuteCommand` and does nothing else on its own. Every executor call gets `runId`, `nodeId`, `attemptId` and `ownerToken` so a remote runner can deduplicate.

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

Workspaces are `{ kind: "local", path }` or `{ kind: "managed", id }`. Only the local adapter resolves paths; a hosted executor maps managed ids to whatever isolation it provides.

```ts
import { Runtime, type RunRepository, type ExecuteCommand } from "loopy/runtime";
import { CloudWorker } from "loopy/cloud";

export function worker(store: RunRepository, executor: ExecuteCommand) {
  return new CloudWorker(new Runtime({ store, executor }));
}
// Deliver { runId } only after createRun has committed.
// Ack on disposition "ack"; retry on "retry" or thrown infrastructure failures.
// Malformed, unknown-run and local-workspace deliveries follow the host
// queue's dead-letter or rejection policy.
```

Queue delivery is for the first execution only. Succeeded, failed and interrupted runs come back unchanged no matter how many times a message is redelivered. A cancellation before launch marks the attempt cancelled and puts the run back to pending; a cancellation after launch leaves it uncertain. Resuming is a separate `Runtime.execute` call, and retrying uncertain work needs `retryUncertain: true` on that call, never on a queue message.

Repository implementations must commit attempt and event writes atomically and fence every write on the owner token. Distributed stores need a bounded lease and must mark expired work uncertain; the SQLite store checks process liveness instead. The runtime keeps heartbeats single-flight, checks ownership right before launch, drains heartbeats before the final write, and treats an executor error it cannot classify as uncertain. A fence stops later database writes; it cannot stop a process on another machine.

None of this is a hosted service. That would need tenant-scoped auth and storage, durable dispatch, workspace provisioning and an isolated runner. The local server's in-memory job set and loopback token are conveniences for one user on one machine: it binds to 127.0.0.1, checks host and origin, requires the token on every API call, and serves a snapshot of the viewer assets taken at startup so a rebuild cannot swap code under a running page.

## Development

```sh
bun run check       # build, lint, typecheck, test
bun run fmt
bun run loopy ui
```
