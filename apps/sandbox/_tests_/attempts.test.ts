import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { decodeBoundary, type ExecutionResult, nodeIdSchema } from "@loopy/contract";
import {
  attemptRecordSchema,
  type DockerAttemptPlan,
  type SandboxAttemptRequest,
  sandboxArtifactSchema,
  sandboxAttemptRequestSchema,
  sandboxErrorSchema,
} from "@loopy/contract/sandbox";
import { canonicalJson } from "@loopy/core";
import { CommandExecutionError } from "@loopy/runtime/os";
import { Effect, Result, Schema } from "effect";
import { qualityTestRoot } from "../../../packages/runtime/_tests_/fixtures/quality-test-root";
import type { ArtifactReader } from "../src/artifacts";
import type { Attempts } from "../src/attempt";
import type { AttemptDependenciesFactory } from "../src/attempt/dependencies";
import { sandboxConfigSchema } from "../src/config";
import { type AttemptBackend, DockerBackend } from "../src/docker";
import { DockerClient } from "../src/docker/client";
import { ownerOf, SANDBOX_DOCKER_CONTEXT, SANDBOX_IMAGE } from "../src/docker/identity";
import { filesystemStorage } from "../src/filesystem";
import { FilesystemJournal } from "../src/filesystem/journal";
import { failure } from "../src/operations";
import type { CommandRunner } from "../src/process";
import { attemptHandler } from "../src/server";
import { stateLayout, validateStateRoot } from "../src/state-root";
import { artifactReader as idleArtifactReader, succeedingBackend } from "./fixtures/authority";
import { openAttempts, openSandbox, run } from "./fixtures/run";

const services: Attempts[] = [];

const token = "sandbox-fixture-token-32-characters";

const succeeded: ExecutionResult = { kind: "succeeded", output: { ok: true }, logs: [] };

// Services close before the test scope releases their attempt scopes and roots.
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => run(service.close())));
});

async function fixture() {
  const worktree = qualityTestRoot("cloud-sandbox");
  await writeFile(join(worktree, "package.json"), JSON.stringify({ private: true }));

  const config = decodeBoundary(sandboxConfigSchema)({
    worktree,
    stateRoot: join(worktree, ".loopy/cloud/sandbox"),
    token,
    dockerContext: SANDBOX_DOCKER_CONTEXT,
    image: SANDBOX_IMAGE,
    port: 0,
  });

  await validateStateRoot(config);

  return config;
}

function request(
  source = "process.stdout.write(JSON.stringify({ok:true}))",
): SandboxAttemptRequest {
  const bytes = Buffer.from(source);
  const hash = createHash("sha256").update(bytes).digest("hex");

  return decodeBoundary(sandboxAttemptRequestSchema)({
    workspace: "workspace-one",
    executionKey: { runId: "run-one", nodeId: decodeBoundary(nodeIdSchema)("0:code"), scope: [] },
    attempt: 1,
    spec: { kind: "code", bundleHash: hash, input: {}, timeoutMs: 1000 },
    bundles: [{ hash, bytes: bytes.toString("base64") }],
  });
}

function dependencies(
  config: Awaited<ReturnType<typeof fixture>>,
  backend: AttemptBackend,
  artifactReader: ArtifactReader = idleArtifactReader,
): AttemptDependenciesFactory {
  return () =>
    Effect.sync(() => ({ ...filesystemStorage(config.stateRoot), backend, artifactReader }));
}

async function open(
  config: Awaited<ReturnType<typeof fixture>>,
  backend: AttemptBackend,
  artifactReader?: ArtifactReader,
) {
  const service = await openAttempts(config, dependencies(config, backend, artifactReader));

  services.push(service);

  return service;
}

function dockerBackend(config: Awaited<ReturnType<typeof fixture>>, runner: CommandRunner) {
  return new DockerBackend(config, new DockerClient(config, runner));
}

function post(body: SandboxAttemptRequest, authorization = `Bearer ${token}`) {
  return new Request("http://127.0.0.1/attempts", {
    method: "POST",
    headers: { authorization, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function lookup(value: SandboxAttemptRequest) {
  const url = new URL("http://127.0.0.1/attempts");
  url.searchParams.set("workspace", value.workspace);
  url.searchParams.set("key", JSON.stringify(value.executionKey));
  url.searchParams.set("attempt", String(value.attempt));

  return new Request(url, { headers: { authorization: `Bearer ${token}` } });
}

test("authenticated admission fsyncs once, joins duplicate starts, rejects changed content and replays completion", async () => {
  const config = await fixture();
  const completed = Promise.withResolvers<ExecutionResult>();
  let starts = 0;
  let stored: DockerAttemptPlan | undefined;

  const backend: AttemptBackend = {
    start: (plan) =>
      Effect.gen(function* () {
        starts += 1;
        stored = plan;

        const durable = decodeBoundary(attemptRecordSchema)(
          JSON.parse(
            yield* Effect.promise(() =>
              readFile(join(stateLayout(config.stateRoot).receipts, `${plan.id}.json`), "utf8"),
            ),
          ),
        );

        expect(durable.plan).toEqual(plan);
        expect(durable.session.epoch).toBe(1);
        expect(durable.session.nonce.length).toBeGreaterThan(0);

        return yield* Effect.promise(() => completed.promise);
      }),
    recover: () =>
      Effect.gen(function* () {
        return yield* Effect.fail(failure("fixture", new Error("Unexpected recovery.")));
      }),
  };

  const attempts = await open(config, backend);
  const handler = attemptHandler(attempts, token);
  expect(await (await handler(new Request("http://localhost/health"))).json()).toEqual({
    status: "ok",
  });
  const input = request();
  expect((await handler(post(input, "Bearer wrong"))).status).toBe(401);
  expect(await (await handler(lookup(input))).json()).toEqual({ kind: "none" });
  const responses = await Promise.all(Array.from({ length: 12 }, () => handler(post(input))));
  expect(responses.every((response) => response.status === 202)).toBe(true);
  expect(await Promise.all(responses.map((response) => response.json()))).toEqual(
    Array.from({ length: 12 }, () => ({ kind: "started" })),
  );
  const changed = { ...input, spec: { ...input.spec, input: { different: true } } };
  expect((await handler(post(changed))).status).toBe(409);
  completed.resolve(succeeded);
  await run(attempts.drain());
  expect(starts).toBe(1);
  expect(stored?.workspace).toBe(input.workspace);
  expect(await (await handler(lookup(input))).json()).toEqual({
    kind: "finished",
    result: succeeded,
  });
  expect(await (await handler(post(input))).json()).toEqual({
    kind: "finished",
    result: succeeded,
  });
});

test("invalid bundles and malformed identities fail before backend effects", async () => {
  const config = await fixture();
  let effects = 0;

  const backend: AttemptBackend = {
    start: () =>
      Effect.gen(function* () {
        effects += 1;

        return succeeded;
      }),
    recover: () =>
      Effect.gen(function* () {
        effects += 1;

        return succeeded;
      }),
  };

  const handler = attemptHandler(await open(config, backend), token);
  const value = request();

  const rejected = async (response: Response) => ({
    status: response.status,
    message: decodeBoundary(sandboxErrorSchema)(await response.json()).error.message,
  });

  expect(await rejected(await handler(post({ ...value, bundles: [] })))).toEqual({
    status: 400,
    message: "A required execution bundle is missing.",
  });
  expect(
    await rejected(
      await handler(
        post({ ...value, bundles: [{ hash: value.bundles[0]?.hash ?? "", bytes: "eA==" }] }),
      ),
    ),
  ).toEqual({
    status: 400,
    message: "Supply each required bundle once with matching SHA-256 bytes.",
  });
  expect((await handler(post({ ...value, attempt: 0 }))).status).toBe(400);

  for (const route of ["attempts", "artifacts"]) {
    const response = await handler(
      new Request(`http://localhost/${route}?key=invalid&attempt=1&workspace=w&path=out.txt`, {
        headers: { authorization: `Bearer ${token}` },
      }),
    );

    expect((await rejected(response)).message).toBe(
      route === "attempts"
        ? "Supply workspace, JSON execution key and positive attempt."
        : "Supply an attempt identity and a relative artifact file path.",
    );
  }

  expect(effects).toBe(0);
});

test("workspace and attempt identities isolate receipts while run volumes persist between nodes", async () => {
  const config = await fixture();
  const receipts: DockerAttemptPlan[] = [];

  const service = await open(config, {
    start: (plan) =>
      Effect.gen(function* () {
        receipts.push(plan);

        return succeeded;
      }),
    recover: () =>
      Effect.gen(function* () {
        return succeeded;
      }),
  });

  const value = request();
  value.executionKey.scope = [
    { nodeId: decodeBoundary(nodeIdSchema)("2:each"), index: 3 },
    { nodeId: decodeBoundary(nodeIdSchema)("3:each"), index: 7 },
  ];
  await run(service.start(value));
  await run(service.start({ ...value, attempt: 2 }));
  await run(service.start({ ...value, workspace: "workspace-two" }));
  await run(
    service.start({
      ...value,
      executionKey: { ...value.executionKey, nodeId: decodeBoundary(nodeIdSchema)("1:code") },
    }),
  );
  await run(
    service.start({
      ...value,
      executionKey: { ...value.executionKey, scope: [...value.executionKey.scope].reverse() },
    }),
  );
  await run(service.drain());
  expect(new Set(receipts.map((receipt) => receipt.id)).size).toBe(5);
  expect(receipts[0]?.volume).toBe(receipts[1]?.volume);
  expect(receipts[0]?.volume).toBe(receipts[3]?.volume);
  expect(receipts[0]?.volume).not.toBe(receipts[2]?.volume);
  expect(receipts[0]?.volume).toBe(receipts[4]?.volume);

  for (const receipt of receipts) {
    const expected = createHash("sha256")
      .update(
        canonicalJson({
          root: config.stateRoot,
          workspace: receipt.workspace,
          executionKey: receipt.executionKey,
          attempt: receipt.attempt,
        }),
      )
      .digest("hex");

    expect(receipt.id).toBe(expected);
    expect(await run(service.lookup(receipt))).toEqual({ kind: "finished", result: succeeded });
  }
});

test("restart reconciles the saved container and never starts another attempt", async () => {
  const config = await fixture();
  let saved: DockerAttemptPlan | undefined;
  let startedRecord = "";

  const first = await open(config, {
    start: (plan) =>
      Effect.gen(function* () {
        saved = plan;
        startedRecord = yield* Effect.promise(() =>
          readFile(join(stateLayout(config.stateRoot).receipts, `${plan.id}.json`), "utf8"),
        );

        return succeeded;
      }),
    recover: () =>
      Effect.gen(function* () {
        return succeeded;
      }),
  });

  const value = request();
  await run(first.start(value));
  await run(first.drain());
  await run(first.close());
  services.splice(services.indexOf(first), 1);

  if (!saved) {
    throw new Error("Expected a started receipt.");
  }

  // Restore the durable point that a killed service leaves before committing completion.
  await writeFile(join(stateLayout(config.stateRoot).receipts, `${saved.id}.json`), startedRecord);
  const original = saved;
  const recovered: DockerAttemptPlan[] = [];

  const second = await open(config, {
    start: () =>
      Effect.gen(function* () {
        return yield* Effect.fail(
          failure("fixture", new Error("Recovery must not dispatch again.")),
        );
      }),
    recover: (plan) =>
      Effect.gen(function* () {
        recovered.push(plan);

        return succeeded;
      }),
  });

  await run(second.drain());
  expect(recovered).toEqual([original]);
  expect(await run(second.lookup(value))).toEqual({ kind: "finished", result: succeeded });
  expect(await run(second.start(value))).toEqual({ kind: "finished", result: succeeded });
});

async function capturedReceipt() {
  const config = await fixture();
  let saved: DockerAttemptPlan | undefined;

  const service = await open(config, {
    start: (plan) =>
      Effect.gen(function* () {
        saved = plan;

        return succeeded;
      }),
    recover: () =>
      Effect.gen(function* () {
        return succeeded;
      }),
  });

  const input = request();
  await run(service.start(input));
  await run(service.drain());

  if (!saved) {
    throw new Error("Expected a started receipt.");
  }

  return { config, saved, input };
}

function dockerState(
  config: Awaited<ReturnType<typeof fixture>>,
  saved: DockerAttemptPlan,
  running: boolean,
  exitCode = 0,
) {
  return JSON.stringify([
    {
      Config: {
        Labels: {
          "loopy.sandbox.owner": ownerOf(config.stateRoot),
          "loopy.sandbox.request": saved.requestHash,
        },
      },
      State: {
        Status: running ? "running" : "exited",
        Running: running,
        ExitCode: exitCode,
        OOMKilled: false,
      },
    },
  ]);
}

test("Docker create enforces isolation and recovery reads the original bounded result", async () => {
  const { config, saved, input } = await capturedReceipt();
  const calls: string[][] = [];
  const environments: (Record<string, string> | undefined)[] = [];

  const runner: CommandRunner = (argv, options) =>
    Effect.gen(function* () {
      calls.push(argv);
      environments.push(options.env);
      const operation = argv[3];

      return {
        exitCode: 0,
        stderr: "",
        durationMs: 0,
        stdout:
          operation === "container"
            ? dockerState(config, saved, false)
            : operation === "logs"
              ? JSON.stringify(succeeded)
              : "",
      };
    });

  expect(await run(dockerBackend(config, runner).start(saved, input))).toEqual(succeeded);
  expect(new Set(calls.map((argv) => argv.slice(0, 3).join(" ")))).toEqual(
    new Set(["docker --context colima-loopy-cloud-phase1"]),
  );

  for (const environment of environments) {
    expect(environment).not.toHaveProperty("LOOPY_SANDBOX_TOKEN");
  }

  const create = calls.find((args) => args[3] === "create" && args.includes(saved.container));
  expect(create).toBeDefined();
  expect(create).toContain("--read-only");
  expect(create).toContain("none");
  expect(create).toContain("1000:1000");
  expect(create).toContain("ALL");
  expect(create).toContain("no-new-privileges:true");
  expect(create).toContain(`type=volume,source=${saved.volume},target=/workspace`);
  expect(create).toContain(`type=volume,source=${saved.inputVolume},target=/input,readonly`);
  expect(create).not.toContain("--privileged");
  expect(JSON.stringify(calls)).not.toContain("type=bind");
  expect(JSON.stringify(calls)).not.toContain("docker.sock");
  expect(calls.some((args) => args[3] === "cp")).toBe(true);
});

test("Docker timeout kills only the owned worker and missing or killed workers stay uncertain", async () => {
  const { config, saved } = await capturedReceipt();

  for (const scenario of ["timeout", "missing", "killed", "wrong-owner"] as const) {
    const calls: string[][] = [];
    let running = scenario === "timeout";

    const runner: CommandRunner = (argv) =>
      Effect.gen(function* () {
        calls.push(argv);
        const op = argv[3];

        if (op === "kill") {
          running = false;
        }

        if (op === "wait") {
          return yield* Effect.fail(
            new CommandExecutionError({
              reason: "timeout",
              message: "Process timed out.",
              output: { stdout: "", stderr: "", exitCode: -1, durationMs: 0 },
              cause: undefined,
            }),
          );
        }

        if (op === "container" && argv[4] === "inspect") {
          if (scenario === "missing") {
            return { stdout: "", stderr: "", exitCode: 1, durationMs: 0 };
          }

          return {
            stdout: dockerState(
              config,
              scenario === "wrong-owner" ? { ...saved, requestHash: "f".repeat(64) } : saved,
              running,
              scenario === "killed" ? 137 : 0,
            ),
            stderr: "",
            exitCode: 0,
            durationMs: 0,
          };
        }

        return { stdout: "", stderr: "", exitCode: 0, durationMs: 0 };
      });

    const backend = dockerBackend(config, runner);

    if (scenario === "wrong-owner") {
      await expect(run(backend.recover(saved))).rejects.toThrow("ownership does not match");
    } else {
      const result = await run(backend.recover(saved));
      expect(result.kind === "failed" && result.error.code).toBe(
        scenario === "timeout" ? "execution" : "uncertain",
      );
    }

    expect(calls.some((args) => args[3] === "create" || args[3] === "start")).toBe(false);
    expect(calls.some((args) => args[3] === "kill")).toBe(scenario === "timeout");
  }
});

test("lost Docker start acknowledgement and wait transport failure retain started receipts through restart", async () => {
  for (const lostStart of [false, true]) {
    const config = await fixture();
    config.maxTimeoutMs = 150;
    const fault = Promise.withResolvers<void>();
    let saved: DockerAttemptPlan | null = null;
    let running = false;
    let outage = false;
    let starts = 0;
    let kills = 0;

    const runner: CommandRunner = (argv) =>
      Effect.gen(function* () {
        const op = argv[3];
        let stdout = "";
        let exitCode = 0;

        if (op === "start") {
          starts += 1;
          running = true;

          if (lostStart) {
            exitCode = 1;
          }
        }

        if (op === "container" && argv[4] === "inspect") {
          if (saved === null || outage) {
            exitCode = 1;
          } else {
            stdout = dockerState(config, saved, running, running ? 0 : 137);
          }
        }

        if (op === "container" && argv[4] === "ls" && outage) {
          exitCode = 1;
        }

        if (op === "wait") {
          outage = true;
          fault.resolve();
          exitCode = 1;
        }

        if (op === "kill") {
          kills += 1;
          running = false;
        }

        return { stdout, stderr: "", exitCode, durationMs: 0 };
      });

    const backend: AttemptBackend = {
      start: (plan, input, signal) =>
        Effect.gen(function* () {
          saved = plan;

          return yield* dockerBackend(config, runner).start(plan, input, signal);
        }),
      recover: (plan, signal) => dockerBackend(config, runner).recover(plan, signal),
    };

    const first = await open(config, backend);
    const input = request();
    await run(first.start(input));
    await fault.promise;
    expect(await run(first.lookup(input))).toEqual({ kind: "started" });
    expect(running).toBe(true);
    await run(first.close());
    services.splice(services.indexOf(first), 1);
    const persisted = (await diskReceipts(config.stateRoot))[0];
    expect(persisted?.kind).toBe("started");

    if (!persisted) {
      throw new Error("Expected saved attempt identity.");
    }

    await new Promise((resolveWait) =>
      setTimeout(resolveWait, Math.max(0, persisted.plan.deadline - Date.now() + 5)),
    );
    const restored = await open(config, backend);
    expect(await run(restored.lookup(input))).toEqual({ kind: "started" });
    outage = false;
    await run(restored.drain());
    const terminal = await run(restored.lookup(input));
    expect(
      terminal.kind === "finished" &&
        terminal.result.kind === "failed" &&
        terminal.result.error.message,
    ).toContain("owned container was killed");
    expect(starts).toBe(1);
    expect(kills).toBe(1);
    expect(running).toBe(false);
    expect(await run(restored.start(input))).toEqual(terminal);
  }
}, 10_000);

function artifactLookup(input: SandboxAttemptRequest, path: string) {
  const url = new URL(lookup(input).url);
  url.pathname = "/artifacts";
  url.searchParams.set("path", path);

  return new Request(url, { headers: { authorization: `Bearer ${token}` } });
}

test("artifact export requires its finished receipt and fences same-run admissions", async () => {
  const config = await fixture();
  const completion = Promise.withResolvers<ExecutionResult>();
  const secondCompletion = Promise.withResolvers<ExecutionResult>();
  const read = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const exportedVolumes: string[] = [];
  let starts = 0;

  const service = await open(
    config,
    {
      start: () =>
        Effect.gen(function* () {
          starts += 1;

          return yield* Effect.promise(() =>
            starts === 1 ? completion.promise : secondCompletion.promise,
          );
        }),
      recover: () =>
        Effect.gen(function* () {
          return succeeded;
        }),
    },
    {
      cleanup: () => Effect.void,
      read: (plan, path) =>
        Effect.gen(function* () {
          exportedVolumes.push(plan.volume);
          read.resolve();
          yield* Effect.promise(() => release.promise);

          return {
            path,
            bytes: "aGk=",
            sha256: createHash("sha256").update("hi").digest("hex"),
            size: 2,
          };
        }),
    },
  );

  const handler = attemptHandler(service, token);
  const input = request();
  expect((await handler(new Request(artifactLookup(input, "out.txt").url))).status).toBe(401);
  expect((await handler(artifactLookup(input, "out.txt"))).status).toBe(404);
  await run(service.start(input));
  expect((await handler(artifactLookup(input, "out.txt"))).status).toBe(409);
  completion.resolve(succeeded);
  await run(service.drain());

  for (const path of ["/etc/passwd", "../x", "a/../../x", "a//x", "a/./x", "C:\\x", "a\\x", ""]) {
    expect((await handler(artifactLookup(input, path))).status).toBe(400);
  }

  expect((await handler(artifactLookup({ ...input, workspace: "other" }, "out.txt"))).status).toBe(
    404,
  );
  const exporting = handler(artifactLookup(input, "out.txt"));
  await read.promise;
  expect((await handler(post({ ...input, attempt: 2 }))).status).toBe(409);
  expect(starts).toBe(1);
  release.resolve();
  const exported = await exporting;
  expect(exported.status).toBe(200);
  expect(decodeBoundary(sandboxArtifactSchema)(await exported.json())).toMatchObject({
    path: "out.txt",
    size: 2,
    bytes: "aGk=",
  });
  expect(exportedVolumes).toEqual([expect.stringMatching(/^loopy-workspace-[a-f0-9]{64}$/)]);
  await run(service.start({ ...input, attempt: 2 }));
  expect((await handler(artifactLookup(input, "out.txt"))).status).toBe(409);
  expect(exportedVolumes).toEqual([expect.stringMatching(/^loopy-workspace-[a-f0-9]{64}$/)]);
  secondCompletion.resolve(succeeded);
  await run(service.drain());
});

test("state roots reject symlinks and public binding; live root ownership is exclusive", async () => {
  const config = await fixture();
  expect(
    Result.isSuccess(
      Schema.decodeUnknownResult(sandboxConfigSchema, { onExcessProperty: "error" })({
        ...config,
        hostname: "0.0.0.0",
      }),
    ),
  ).toBe(false);
  await expect(
    validateStateRoot({ ...config, stateRoot: join(config.worktree, "elsewhere") }),
  ).rejects.toThrow("<worktree>/.loopy/cloud/sandbox");
  const other = await fixture();
  await rm(join(other.stateRoot, "receipts"), { recursive: true });
  await symlink(config.stateRoot, join(other.stateRoot, "receipts"));
  await expect(validateStateRoot(other)).rejects.toThrow("without symlinks");

  await open(config, succeedingBackend);
  await expect(openAttempts(config, dependencies(config, succeedingBackend))).rejects.toThrow(
    `Process ${process.pid} holds`,
  );
});

test("a lock file from an older sandbox version stops startup with its cleanup steps", async () => {
  const config = await fixture();
  const lock = stateLayout(config.stateRoot).lock;
  await writeFile(lock, JSON.stringify({ pid: 999_999, nonce: "old" }));

  await expect(openAttempts(config, dependencies(config, succeedingBackend))).rejects.toThrow(
    `Lock file '${lock}' was written by an older sandbox version.`,
  );
  expect(await readFile(lock, "utf8")).toBe(JSON.stringify({ pid: 999_999, nonce: "old" }));
});

test("loopback server serves health and an authenticated asynchronous attempt", async () => {
  const config = await fixture();
  const service = await openSandbox(config, dependencies(config, succeedingBackend));

  try {
    const health = await fetch(new URL("/health", service.server.url));
    expect(await health.json()).toEqual({ status: "ok" });
    const input = request();

    const response = await fetch(new URL("/attempts", service.server.url), {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify(input),
    });

    expect(response.status).toBe(202);
    await run(service.attempts.drain());
    expect(await run(service.attempts.lookup(input))).toEqual({
      kind: "finished",
      result: succeeded,
    });
  } finally {
    await run(service.close());
  }
});

test("concurrent restarts reclaim a dead process lock under one startup owner", async () => {
  const config = await fixture();

  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `import {acquirePidLock} from ${JSON.stringify(resolve(import.meta.dir, "../../../packages/runtime/src/os/pid-lock.ts"))}; acquirePidLock(${JSON.stringify(stateLayout(config.stateRoot).lock)});`,
    ],
    {
      stdout: "ignore",
      stderr: "pipe",
    },
  );

  expect(await child.exited).toBe(0);

  const results = await Promise.allSettled([
    openAttempts(config, dependencies(config, succeedingBackend)),
    openAttempts(config, dependencies(config, succeedingBackend)),
  ]);

  expect(results.filter((result) => result.status === "fulfilled").length).toBe(1);
  expect(results.filter((result) => result.status === "rejected").length).toBe(1);

  for (const result of results) {
    if (result.status === "fulfilled") {
      services.push(result.value);
    }
  }
});

function diskReceipts(root: string) {
  return run(new FilesystemJournal(root).records());
}
