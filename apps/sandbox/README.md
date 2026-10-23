# Local cloud sandbox

This Bun service accepts asynchronous execution attempts. It uses an explicitly selected Docker context and never changes the default context. There is no Modal integration.

From the repository root, build the worker image in the dedicated daemon:

```sh
docker --context colima-loopy-cloud-phase1 build \
  --file apps/sandbox/Dockerfile --tag loopy-sandbox:bun-1.4.0 .
```

The image uses the official `oven/bun:1.4.0` image for its build and runtime stages. It includes Bun and the base image's commands. Build a derived image when a workflow needs other executables, then pass its tag through `--image`.

Start the service with an existing private token of at least 32 characters in `LOOPY_SANDBOX_TOKEN`. From the real checkout directory, use its absolute path in both path flags:

```sh
bun apps/sandbox/src/index.ts \
  --worktree "$PWD" \
  --state-root "$PWD/.loopy/cloud/sandbox" \
  --docker-context colima-loopy-cloud-phase1 \
  --image loopy-sandbox:bun-1.4.0 \
  --hostname 127.0.0.1 --port 4010
```

`--worktree`, `--state-root`, `--docker-context` and the token are required. The state root must be exactly `<worktree>/.loopy/cloud/sandbox`. The service rejects symlinked state directories and worktree paths. It never uses `~/.loopy`. Binding is limited to `127.0.0.1` and `::1`. A process lock prevents two services from reconciling the same receipts. A dead service PID is reclaimed under an exclusive startup guard. A crash during startup can leave `service-start.lock`. Verify that no startup process is running before removing that guard.

Execution flags are `--max-timeout-ms 600000`, `--memory 256m`, `--cpus 1` and `--pids 64`. The timeout flag caps the entire attempt, including staging. Requested code timeouts and command timeouts also apply inside the container. Commands default to 300 seconds, and parsers have a separate 300 second limit. The outer deadline allows 30 seconds for staging, up to the configured maximum.

## Receipt authority modes

The CLI above and `cloud:start` use filesystem authority. It serializes writes under the state-root process lock and a process-local session. Its epoch is not persistent. New attempt records live in `receipts/`, immutable terminal result files in `results/`, and active guards plus released-token records in `exports/`. A terminal record points to result bytes by SHA-256 and size instead of embedding the result.

The architecture playground injects `HttpSandboxAuthority` backed by the Worker's `SANDBOX_RECEIPTS` DO and `RECEIPT_RESULTS` R2 bucket. The default playground profile remains filesystem-backed. DO sessions persist epoch and nonce, fencing writers from earlier bridge processes. Receipt SQL owns admission, terminal pointers and export guards; R2 owns immutable result bytes. The sandbox CLI has no DO-mode flag.

The dependency factory in `startSandbox(config, createDependencies)` is optional; omitting it selects filesystem authority. DO-backed callers pass a custom factory supplying authority, matching result storage, execution backend and artifact reader together. The coordinator validates the state root and acquires its process lock before invoking the selected factory, then opens a session and reconciles persisted work. A durable harness rejects populated filesystem receipts/exports when selecting DO authority; use a fresh root rather than switch an existing dataset in place.

The local Worker bridge uses `POST /internal/sandbox-receipts`. DO composition requires `RECEIPTS_TOKEN`, `RECEIPTS_NAMESPACE` and `RECEIPTS_ROOT`, with matching client credentials and namespace. The namespace/root pair is fixed in receipt SQL. The bridge token must differ from user principal tokens. `SANDBOX_RECEIPTS`, `RECEIPT_RESULTS` and the `v2-receipts` migration are declared in the [cloud configuration](../cloud/README.md#receipt-authority-and-configuration). Keep generated private config and credentials out of output and commits.

## HTTP contract

`GET /health` returns `{"status":"ok"}` without authentication. All other routes require `Authorization: Bearer <token>`. The service does not enable browser CORS.

`POST /attempts` accepts this shape and returns HTTP 202 with the current receipt:

```ts
{
  workspace: string,
  executionKey: ExecutionKey,
  attempt: number,
  spec: ExecutionSpec,
  bundles: Array<{ hash: string; bytes: string }>
}
```

`workspace` is an opaque namespace, not a host filesystem path. `attempt` is a positive integer. Bundle bytes use canonical base64 and must match their SHA-256 hash. Supply exactly the bundle referenced by the code spec or command parser, or an empty array for a command without a parser. No host secrets are injected. Explicit `spec.env` values belong to the request, so callers must not send secrets to this phase-one service.

`GET /attempts?workspace=...&key=...&attempt=1` looks up a receipt. Set `key` to `JSON.stringify(executionKey)` and encode query parameters using `URLSearchParams`.

Both routes return the shared `SandboxReceipt` union:

```ts
{ kind: "none" }
{ kind: "started" }
{ kind: "finished", result: ExecutionResult }
```

`none` occurs only on lookup. Duplicate POSTs return the existing receipt. Changed content for the same workspace, execution key and attempt returns HTTP 409, including after completion. Other errors have `{error:{code,message}}`, with 400 for invalid requests, 401 for authentication, 404 for unknown routes, 413 for oversized requests and 500 for storage failures.

The exported Zod schemas and inferred types live in `loopy/contract`: `sandboxAttemptRequestSchema`, `sandboxAttemptIdentitySchema`, `sandboxExecutionSpecSchema`, `sandboxExecutionResultSchema`, `sandboxReceiptSchema`, `sandboxArtifactRequestSchema`, `sandboxArtifactSchema` and `sandboxErrorSchema`. These imports remain browser-safe.

## Workspace artifact export

`GET /artifacts?workspace=...&key=...&attempt=1&path=artifacts/result.json` uses the same bearer token and identity encoding as attempt lookup. It requires an existing finished receipt for that exact identity and derives the workspace volume only from that receipt. The response is `SandboxArtifact`:

```ts
{ path: string, bytes: string, sha256: string, size: number }
```

`bytes` is canonical base64, `sha256` is the SHA-256 of the decoded bytes, and `size` is the decoded byte count. The maximum file size is 1 MiB. Empty regular files are supported. Missing receipts, volumes and files return 404. Invalid paths, symlinks and nonregular files return 400. Oversized files return 413 with code `output_limit`. Started attempts or an active worker sharing the volume return 409. The authority persists an export guard before helper work and blocks same-volume admission until cleanup is confirmed. Failed cleanup keeps the guard for reconciliation, including across restart; released-token records prevent a delayed duplicate from reopening an export.

Paths must be relative, at most 1,024 characters and slash-separated. Absolute paths, empty components, `.` and `..`, backslashes, colons and control characters are rejected. A trusted helper opens every ancestor directory and the final file through held descriptors with `O_NOFOLLOW`, checks the final descriptor is a regular file, reads at most the limit plus one byte, and rejects files whose metadata changes during the read. The helper mounts the receipt's volume read-only and runs without network, capabilities, new privileges, host mounts or host credentials. It has a read-only root, a 128 MiB memory limit, 0.5 CPU, 32 PIDs and a 10 second read deadline. Its exact name is `loopy-artifact-<receipt.id>`. Ownership labels are checked before cleanup.

Call this endpoint after the cloud run is terminal. It exports the current run workspace, not a historical snapshot of an individual attempt. Later nodes can overwrite a previous node's files. Export never imports a workflow bundle, creates a new attempt or runs a workflow command.

## Execution and recovery

Admission persists a started attempt before any Docker calls. Its plan pins the request hash, container name, input volume, run volume and absolute deadline. Filesystem publication fsyncs files and directories; DO publication uses synchronous SQL transactions. Completion stores immutable result bytes first and verifies their size, hash and schema before publishing the terminal pointer under the current session and attempt identity. DO verification happens outside the transaction, followed by authority rechecks inside it. Later result reads verify the immutable reference again. Missing or corrupt bytes fail closed without permitting a terminal attempt to run again.

A stopped staging helper receives files through `docker cp` into a dedicated input volume. The execution container mounts that volume read-only. A named workspace volume is shared only by attempts with the same state root, workspace and run ID, so sequential commands keep their files. Command `cwd` must resolve inside `/workspace`, including symlink resolution. Code bundles receive JSON on stdin and use the existing final JSON stdout line and structured stderr log protocol. Commands reuse the existing descriptor renderer, exit-code rules and parser protocol.

Execution containers run as UID/GID 1000 with no network, dropped capabilities, no new privileges, read-only root filesystems, a bounded `/tmp` tmpfs, an init process, and CPU, memory, PID and file-descriptor limits. The service uses no host bind mounts, personal home mounts or Docker socket mounts. Only the host service talks to Docker.

Docker transport errors keep the durable receipt started. The service reconciles only the original container with backoff from 100 ms up to 5 seconds. It never repeats a start request. A service shutdown interrupts monitoring and preserves started receipts for the next process. On restart, the service inspects the original labelled container. It joins a running worker until the saved deadline, or reads bounded output from a finished worker. A missing container, an unstarted container, a killed worker, an OOM kill or an invalid terminal result becomes a failed `uncertain` result. It never launches the attempt again. Deadline expiry kills the owned running container and saves a terminal timeout failure. Container ownership labels must match before recovery or termination.

Requests are capped at 16 MiB, individual bundles at 8 MiB, combined process stdout/stderr at 2 MiB, successful output at 1 MiB and retained logs at 64 KiB. These caps also apply during recovery. Artifact reads have a separate 1 MiB file limit.

Receipts, result blobs, export records, stopped containers and named volumes remain available for inspection. There is no automatic garbage collector. Stop only the service you own and let shutdown settle admissions, monitors and exports before releasing the process lock. Derive an exact container/volume allowlist from this authority's attempt plans, inspect uncertain attempts, verify ownership labels and confirm removal. A crash during staging can leave `<container>-input` and its input volume. Export recovery must confirm removal of the exact owned helper before releasing its guard. Never prune by name prefix or broad label.

Keep admission, result, session and export records when removing container resources. Deleting admission records can permit re-execution; deleting result blobs breaks terminal reads; deleting guards can release a volume prematurely. In DO mode, preserve the matching Wrangler SQL/R2 state and namespace/root configuration as well as the bridge root. Do not erase retained datasets or historical evidence as routine teardown.

## Retained data

Legacy flat filesystem receipts with inline results remain readable because accepted datasets still use them. Remove that decoder only after every retained root has a verified migration or explicit retirement, including reconciliation of all started attempts and export guards. Preserve historical evidence; deleting data is not migration. See the [cloud README](../cloud/README.md) for the phase 2 approval boundary.

## Tests

See [AGENTS.md](../../AGENTS.md#tests-and-isolation) for test roots and fixture isolation. Run the boundary tests without Docker:

```sh
bun test packages/loopy/_tests_/cloud-sandbox.test.ts
```

After building the image, enable direct execution checks explicitly:

```sh
LOOPY_SANDBOX_DOCKER_CONTEXT=colima-loopy-cloud-phase1 \
  bun test packages/loopy/_tests_/cloud-sandbox.test.ts
```

The direct checks create named fixtures in that context. Teardown builds an allowlist from those fixtures' durable receipts, removes only their exact attempt, staging and artifact helper names, removes only the exact input and workspace volumes recorded there, and verifies each volume is absent. It never prunes or deletes by a broad Docker label or name prefix. Production receipts remain intact when container resources are removed.
