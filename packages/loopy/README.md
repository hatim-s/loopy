# Loopy

A loopy is a compiled TypeScript workflow graph. Save it by name, run it with typed input, and inspect its node executions and logs. SQLite records the graph cursor and execution results so interrupted runs can continue.

Requires Bun 1.4 or newer. The package root is the authoring SDK. `loopy/engine` exposes the graph engine contracts; the CLI manages the local daemon.

## Try it

```sh
bun install
bun run check
bun run loopy save examples/hello.loopy.ts
bun run loopy run hello --name Hatim --enthusiastic true
bun run loopy runs hello
bun run loopy ui
```

`loopy ui` prints the authenticated URL for the dashboard served by the daemon. Open it in your browser. If no daemon is running, the command starts one on demand and exits. The URL selects the caller workspace.

To install the CLI globally, run `bun run install:global`. The installer builds and packs the package into `~/.loopy/packages/loopy-<sha256>.tgz`, installs it with Bun, and prints a command for adding the same archive to a project. A project that imports `loopy` needs its own dependency. Put `bun pm bin -g` on your PATH.

## Dashboard

Home lists saved loopies and recent runs. Each loopy page has an input form, schedule details, status filters and paged runs. A run page shows its inputs, output, live step trace, logs, hook resolution and run controls. Inbox groups waiting hooks by loopy, oldest first. The schedules page is being added separately for listing and toggling schedules. The daemon page shows its process, start time, concurrency, active runs and next wake. One event stream updates the session query cache; reconnects resume from the cursor, and stale cursors or a changed store epoch trigger a refetch.

## Write a loopy

Save this as `review.loopy.ts` in a project with the `loopy` dependency:

```ts
import { defineCommand, git, loopy } from "loopy";

const codex = defineCommand({
  key: "codex.exec",
  program: "codex",
  path: ["exec"],
  positionals: [{ name: "prompt" }],
  positionalSeparator: true,
  flags: { sandbox: { cli: "--sandbox", kind: "string", choices: ["read-only"] } },
});

export default loopy({
  name: "review",
  description: "Review tracked changes without editing files.",
  mode: "full",
  input: { "instructions?": "string" },
  run: async ({ input, log }) => {
    const changes = await git.diff();

    if (changes.length === 0) {
      log.info("No changes to review.");

      return { outcome: "clean", review: null };
    }

    const diff = (await git.diff.raw()).stdout;
    const result = await codex(
      { args: ["-"], flags: { sandbox: "read-only" } },
      { stdin: `Review these changes.\n${diff}\n${input.instructions ?? "Find bugs."}`, timeout: "10m" },
    );
    const review = result.stdout.trim();
    log.info("Review completed.", { characters: review.length });

    return { outcome: "reviewed", review };
  },
});
```

`loopy()` accepts a name, description, input schema, scope, mode, secret names, optional schedule and `run` function. The default scope is `project`; the default mode is `sandbox`. Use `scope: "global"` to make a loopy available from other projects. Saving bundles the definition and its imports. Inside the bundle, each module's `import.meta.url`, `path`, `file` and `dir` still name its source file, so `fileURLToPath(new URL("./cli.py", import.meta.url))` finds a sibling script. Existing runs retain their original bundle when you save a new version.

A record input specification supports `string`, `number` and `boolean`; suffix an optional key with `?`. Named CLI flags coerce those types and prompt for missing required fields in a terminal. Standard Schema v1 validators are also supported, with their inferred input type passed to `run`. Use JSON input for Standard Schema definitions.

```sh
loopy save review.loopy.ts
loopy run review --instructions "Check error handling."
loopy run review --input-json '{"instructions":"Check error handling."}'
loopy run review --input-file input.json
```

Choose one input source per invocation. Use `--key=value` for values starting with `--`, or `-- --key value` for input names that collide with command options. Mode belongs in the definition. `--home` chooses the local home, and `--cwd` chooses the workspace for a new run. Resume keeps the original workspace.

## Run, inspect and schedule

```sh
loopy list
loopy runs review
loopy inspect <run-id>
loopy logs <run-id>
loopy logs <run-id> --follow
loopy resume <run-id>
loopy cancel <run-id>

loopy run review --detach
loopy daemon run --concurrency 4
loopy schedule review --cron '0 9 * * 1-5' --tz Asia/Kolkata
loopy schedule review --disable
loopy schedule review --enable
loopy schedule review --off
```

An inline run activates until it finishes or suspends without a wake time. For a timed sleep or retry, it waits and activates again. Ctrl-C and SIGTERM leave unfinished work resumable. `--detach` creates a queued run without executing it; the foreground daemon claims queued and due runs. `resume` continues queued, suspended or abandoned runs. A finished run stays finished; start a new run to try a failed workflow again. Cancellation requires a claimable run. Stop its runner before cancelling an actively owned run.

`runs [slug]` prints the stored runs as a JSON array. Dashboard run lists page newest first and load older runs on request. The HTTP API accepts `slug`, `status`, `limit` and `before` filters.

`inspect` returns a snapshot with the run, ordered steps, logs, hooks, event cursor and store epoch. Run statuses are `queued`, `running`, `suspended`, `succeeded`, `failed` and `cancelled`. Each step records its sequence, key, kind, attempt, status and result or error. Logs carry their workflow position or step attempt. `logs --follow` emits one JSON object per line.

A definition can include `schedule: { cron: "0 9 * * 1-5", tz: "Asia/Kolkata" }`. `loopy schedule <slug>` uses those defaults; flags override them. Pass schedule input with `--input-json`. `--disable` pauses a saved schedule; `--enable` resumes it. `--off` deletes it. These actions cannot be combined with each other or with cron, timezone or input flags. Schedules retain their workspace, even when the daemon starts elsewhere. Missed fires are not backfilled. Scheduling stores the next fire time; keep `loopy daemon run` running to execute it. Cron uses five fields and defaults to UTC. Command options are scoped: `--follow` belongs to logs, `--concurrency` to daemon run and install, and `--cron`, `--tz`, `--enable`, `--disable` and `--off` to schedule.

### Run the daemon as a service

```sh
loopy daemon install --concurrency 4
loopy daemon status
loopy daemon uninstall
```

`loopy daemon status` reads `<home>/daemon.json` and prints the live daemon's PID, port, bearer token and start time. It prints `{ "state": "stopped" }` when no live daemon is recorded. The daemon creates this private file at startup and removes it on shutdown.

Install starts a launchd user agent on macOS or a systemd user unit on Linux.
Reinstall updates the service and restarts it. Use `--home /absolute/path` when
installing to select another Loopy home. Output and errors append to
`<home>/logs/daemon.log`, normally `~/.loopy/logs/daemon.log`.
The service runs in your user session. On Linux, use systemd user lingering if
it must keep running after logout. Keep Bun and the installed CLI at their
installation paths, then reinstall the service after moving either one.

## Typed shell wrappers

`git`, `fs`, `text`, `net` and `archive` expose typed commands. Each call records one command step. Git parsers return structured results:

```ts
const status = await git.status();
log.info("Working tree read.", {
  branch: status.branch,
  staged: status.staged.length,
  unstaged: status.unstaged.length,
  untracked: status.untracked.length,
});
```

Use `.raw()` on a parsed command for its `stdout`, `stderr`, `exitCode` and `durationMs`. Parser-owned output flags are protected on parsed calls. Other wrappers return command results unless their descriptor supplies a parser.

`sh.run("git diff --stat")` parses a small argv syntax with quotes and escapes. It does not expand variables or glob patterns, or support pipes, redirects and command substitution. Use `sh.exec(["program", ...args])` for dynamic arguments. Both accept stdin, cwd, environment, timeout and retry options. Do not wrap shell calls in `step`; they are already steps.

Generate a wrapper for another CLI with `loopy types codex exec --out codex.ts --name codexExec`. Review the generated descriptor and warnings, then import its `defineCommand` wrapper. Help text can omit repeatability or alternative usage forms.

## Determinism and retries

The engine identifies a step by its sequence and checks its key on replay. Keep branches and code between steps deterministic. Put external reads and effects in a shell wrapper or `step("name", fn)`. Step results must be JSON. Use context `now()`, `random()` and `uuid()` instead of unrecorded time or randomness. Await each call, for example `const at = await now()`, `const value = await random()` and `const id = await uuid()`. These calls also create steps. `sleep("1h")` persists a wake time and suspends without keeping a timer alive in the daemon.

Steps cannot nest, including shell calls inside a function step. A function step receives `{ log, attempt }` for attempt-specific logs. Use workflow `log.info`, `log.warn` and `log.error` between steps. The engine deduplicates workflow logs by replay position and retains logs from each executed step attempt. `parallel`, bounded `map` and `race` compose step calls; recorded completion order controls replay delivery. A changed step key fails with a nondeterminism error even if workflow code catches it.

Composition accepts functions that return promises:

```ts
const [status, files] = await parallel([() => git.status(), () => git.lsFiles()]);
const results = await map(items, async (item, index) => processItem(item, index), { concurrency: 4 });
const first = await race([() => queryPrimary(), () => queryReplica()]);
```

The default is three attempts with exponential delays starting at one second, doubling to a 60-second cap without jitter. Function failures, spawn failures and timeouts can retry. Nonzero command exits require `retry: { retryOn: "exit" }`; parser errors and non-JSON outputs fail without retry. Set `retry: { attempts: 1 }` to disable automatic retries. Durations accept milliseconds or strings such as `"30s"`, `"10m"`, `"1h"` and `"2d"`.

Runners heartbeat every 15 seconds while holding a run. After a crash, resume or the daemon can reclaim ownership once its heartbeat is more than 60 seconds old. On the same host, a dead PID permits immediate recovery. The `--lease-ms` global option overrides the lease duration. Unfinished running steps retry with the next attempt number. A process can finish an effect before its result is persisted. Crash recovery can execute that unfinished step again. Use idempotent operations or external idempotency keys for publication and other effects that must not repeat.

## Execution and secrets

Sandbox mode denies network access and confines writes to the workspace using sandbox-exec on macOS or bwrap on Linux. Other platforms have no supported sandbox and reject sandbox mode. Device access includes /dev/null and /dev/tty writes on macOS. An unavailable or failed sandbox never falls back to full permissions. `mode: "full"` runs with the host environment and permissions; use it deliberately for network tools and automation that needs other checkouts. Saved TypeScript executes during save and activation, so only save code you trust.

Declare `secrets: ["NPM_TOKEN"]` in the definition and store each value privately:

```sh
loopy secrets set NPM_TOKEN
loopy secrets set NPM_TOKEN --stdin
loopy secrets list
loopy secrets remove NPM_TOKEN
```

The local executor reads declared values at activation and injects them as environment variables at process launch. It redacts those values from command output and execution errors, including truncated output prefixes. Missing values prevent execution. The store is plaintext with user-only permissions; default secrets live at `~/.loopy/secrets.json`. A custom home keeps `secrets.json` inside that home.

Run records retain input, command argv, explicit environment and stdin, step results, errors and logs. Keep credentials out of those fields. Redaction covers declared command secrets; it does not make arbitrary workflow data private.

## Local files

```text
~/.loopy/
  secrets.json
  daemon.json
  logs/daemon.log
  loopies/<slug>.json
  bundles/<sha256>.js
  runs.sqlite
<project>/.loopy/loopies/<slug>.json
```

Set `LOOPY_HOME` or pass `--home` to move the home. Project lookup checks the nearest ancestor containing `.loopy/loopies`; project entries override global entries. A slug belongs to its canonical source file. Use `loopy save <file.ts> --replace` to transfer ownership. A schema-version mismatch deletes all runs, steps, logs and schedules; there is no data migration.

## Examples

- [Hello](examples/hello.loopy.ts) records a greeting as a function step.
- [Review](examples/review.loopy.ts) reads a parsed Git diff and asks Codex for a review.
- [Uacode asset sync](examples/uacode-asset-sync/asset-sync-pr.loopy.ts) previews or applies exported assets, then publishes a focused PR. See its [inputs and prerequisites](examples/uacode-asset-sync/README.md).
- [WWW prompt sync](examples/www-uacode-sync/www-uacode-sync.loopy.ts) maps prompts and skills into uacode assets and publishes one PR per changed base. See its [run instructions](examples/www-uacode-sync/README.md).

## Rate limits

Set shared per-key limits in `<home>/config.json`, for example
`{ "rateLimits": { "codex": "10/1h", "gh": "60/1m" } }`. The CLI and daemon
read this file at startup. A `rateLimit` key absent from config.json fails the step.
Completed steps replay without acquiring a slot; waiting for a slot does not consume
an attempt.

```ts
await step("generate", () => generate(), { rateLimit: "codex" });
```

## Hooks

`hook()` suspends a run until an external signal supplies JSON. Without a timeout,
inline `loopy run` prints the hook name and run ID and exits successfully with a
suspended run. Resolve it, then continue with `loopy resume <run-id>`:

```ts
const approval = await hook("approve");
// loopy hook <run-id> approve --payload '{"ok":true}'
```

Pass `{ timeout: "1h" }` to set a deadline. A timeout fails the step without retrying.
`loopy inspect <run-id>` shows names and tokens. Local automation can POST a JSON
body to `/api/hooks/<token>` on the daemon server with
`Authorization: Bearer <daemon-token>`, using the token from the dashboard URL. The same authentication and
origin checks apply. This endpoint is for local automation, not public webhooks.
