import { afterEach, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ArtifactReader } from "../../../apps/sandbox/src/artifacts.js";
import { Attempts } from "../../../apps/sandbox/src/attempts.js";
import { sandboxConfigSchema, validateStateRoot } from "../../../apps/sandbox/src/config.js";
import { type AttemptBackend, DockerBackend } from "../../../apps/sandbox/src/docker.js";
import { filesystemDependencies } from "../../../apps/sandbox/src/filesystem.js";
import { CaptureError, type CommandRunner, runCommand } from "../../../apps/sandbox/src/process.js";
import { type StartedReceipt, storedReceiptSchema } from "../../../apps/sandbox/src/receipts.js";
import { attemptHandler, startSandbox } from "../../../apps/sandbox/src/server.js";
import {
  nodeIdSchema,
  type SandboxAttemptRequest,
  type SandboxExecutionResult,
  sandboxArtifactSchema,
  sandboxAttemptRequestSchema,
} from "../src/contract/index.js";
import { attemptRecordSchema } from "../src/contract/sandbox-journal.js";
import { commandSpec } from "./fixtures/executor.js";

const roots: string[] = [];

const services: Attempts[] = [];

const token = "sandbox-fixture-token-32-characters";

const succeeded: SandboxExecutionResult = { kind: "succeeded", output: { ok: true }, logs: [] };

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const worktree = await realpath(await mkdtemp(join(tmpdir(), "loopy-cloud-sandbox-")));
  roots.push(worktree);

  const config = sandboxConfigSchema.parse({
    worktree,
    stateRoot: join(worktree, ".loopy/cloud/sandbox"),
    token,
    dockerContext: "colima-loopy-cloud-phase1",
    image: "loopy-sandbox:bun-1.4.0",
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

  return sandboxAttemptRequestSchema.parse({
    workspace: "workspace-one",
    executionKey: { runId: "run-one", nodeId: nodeIdSchema.parse("0:code"), scope: [] },
    attempt: 1,
    spec: { kind: "code", bundleHash: hash, input: {}, timeoutMs: 1000 },
    bundles: [{ hash, bytes: bytes.toString("base64") }],
  });
}

async function open(
  config: Awaited<ReturnType<typeof fixture>>,
  backend: AttemptBackend,
  artifactReader?: ArtifactReader,
) {
  const service = await Attempts.open(
    config,
    filesystemDependencies(config, { backend, artifactReader }),
  );

  services.push(service);

  return service;
}

// BOUNDARY: HTTP fixtures include malformed JSON objects to exercise request validation.
function post(body: unknown, authorization = `Bearer ${token}`) {
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
  const completed = Promise.withResolvers<SandboxExecutionResult>();
  let starts = 0;
  let stored: StartedReceipt | undefined;

  const backend: AttemptBackend = {
    start: async (receipt) => {
      starts += 1;
      stored = receipt;

      const durable = attemptRecordSchema.parse(
        JSON.parse(
          await readFile(join(config.stateRoot, "receipts", `${receipt.id}.json`), "utf8"),
        ),
      );

      expect({ ...durable.plan, kind: "started" }).toEqual(receipt);
      expect(durable.session.epoch).toBe(1);
      expect(durable.session.nonce.length).toBeGreaterThan(0);

      return completed.promise;
    },
    recover: async () => {
      throw new Error("Unexpected recovery.");
    },
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
  await attempts.drain();
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
    start: async () => {
      effects += 1;

      return succeeded;
    },
    recover: async () => {
      effects += 1;

      return succeeded;
    },
  };

  const handler = attemptHandler(await open(config, backend), token);
  const value = request();
  expect((await handler(post({ ...value, bundles: [] }))).status).toBe(400);
  expect(
    (await handler(post({ ...value, bundles: [{ hash: value.bundles[0]?.hash, bytes: "eA==" }] })))
      .status,
  ).toBe(400);
  expect((await handler(post({ ...value, attempt: 0 }))).status).toBe(400);
  expect(
    (
      await handler(
        new Request("http://localhost/attempts?key=invalid&attempt=1&workspace=w", {
          headers: { authorization: `Bearer ${token}` },
        }),
      )
    ).status,
  ).toBe(400);
  expect(effects).toBe(0);
});

test("workspace and attempt identities isolate receipts while run volumes persist between nodes", async () => {
  const config = await fixture();
  const receipts: StartedReceipt[] = [];

  const service = await open(config, {
    start: async (receipt) => {
      receipts.push(receipt);

      return succeeded;
    },
    recover: async () => succeeded,
  });

  const value = request();
  await service.start(value);
  await service.start({ ...value, attempt: 2 });
  await service.start({ ...value, workspace: "workspace-two" });
  await service.start({
    ...value,
    executionKey: { ...value.executionKey, nodeId: nodeIdSchema.parse("1:code") },
  });
  await service.drain();
  expect(new Set(receipts.map((receipt) => receipt.id)).size).toBe(4);
  expect(receipts[0]?.volume).toBe(receipts[1]?.volume);
  expect(receipts[0]?.volume).toBe(receipts[3]?.volume);
  expect(receipts[0]?.volume).not.toBe(receipts[2]?.volume);
});

test("restart reconciles the saved container and never starts another attempt", async () => {
  const config = await fixture();
  let saved: StartedReceipt | undefined;

  const first = await open(config, {
    start: async (receipt) => {
      saved = receipt;

      return succeeded;
    },
    recover: async () => succeeded,
  });

  const value = request();
  await first.start(value);
  await first.drain();
  await first.close();
  services.splice(services.indexOf(first), 1);

  if (!saved) {
    throw new Error("Expected a started receipt.");
  }

  // Restore the durable point that a killed service leaves before committing completion.
  await writeFile(join(config.stateRoot, "receipts", `${saved.id}.json`), JSON.stringify(saved));
  const original = saved;
  let recovered = 0;

  const second = await open(config, {
    start: async () => {
      throw new Error("Recovery must not dispatch again.");
    },
    recover: async (receipt) => {
      expect(receipt).toEqual(original);
      recovered += 1;

      return succeeded;
    },
  });

  await second.drain();
  expect(recovered).toBe(1);
  expect(await second.lookup(value)).toEqual({ kind: "finished", result: succeeded });
  expect(await second.start(value)).toEqual({ kind: "finished", result: succeeded });
});

async function capturedReceipt() {
  const config = await fixture();
  let saved: StartedReceipt | undefined;

  const service = await open(config, {
    start: async (receipt) => {
      saved = receipt;

      return succeeded;
    },
    recover: async () => succeeded,
  });

  const input = request();
  await service.start(input);
  await service.drain();

  if (!saved) {
    throw new Error("Expected a started receipt.");
  }

  return { config, saved, input };
}

function dockerState(
  config: Awaited<ReturnType<typeof fixture>>,
  saved: StartedReceipt,
  running: boolean,
  exitCode = 0,
) {
  return JSON.stringify([
    {
      Config: {
        Labels: {
          "loopy.sandbox.owner": createHash("sha256").update(config.stateRoot).digest("hex"),
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

  const runner: CommandRunner = async (argv, options) => {
    calls.push(argv);
    expect(argv.slice(0, 3)).toEqual(["docker", "--context", "colima-loopy-cloud-phase1"]);
    expect(options.env).not.toHaveProperty("LOOPY_SANDBOX_TOKEN");
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
  };

  expect(await new DockerBackend(config, runner).start(saved, input)).toEqual(succeeded);
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

    const runner: CommandRunner = async (argv) => {
      calls.push(argv);
      const op = argv[3];

      if (op === "kill") {
        running = false;
      }

      if (op === "wait") {
        throw new CaptureError("timeout");
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
    };

    const backend = new DockerBackend(config, runner);

    if (scenario === "wrong-owner") {
      await expect(backend.recover(saved)).rejects.toThrow("ownership does not match");
    } else {
      const result = await backend.recover(saved);
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
    let saved: StartedReceipt | null = null;
    let running = false;
    let outage = false;
    let starts = 0;
    let kills = 0;

    const runner: CommandRunner = async (argv) => {
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
    };

    const backend: AttemptBackend = {
      start: async (receipt, input, signal) => {
        saved = receipt;

        return new DockerBackend(config, runner).start(receipt, input, signal);
      },
      recover: (receipt, signal) => new DockerBackend(config, runner).recover(receipt, signal),
    };

    const first = await open(config, backend);
    const input = request();
    await first.start(input);
    await fault.promise;
    expect(await first.lookup(input)).toEqual({ kind: "started" });
    expect(running).toBe(true);
    await first.close();
    services.splice(services.indexOf(first), 1);
    const persisted = (await diskReceipts(config.stateRoot))[0];
    expect(persisted?.kind).toBe("started");

    if (!persisted) {
      throw new Error("Expected saved attempt identity.");
    }

    await new Promise((resolveWait) =>
      setTimeout(resolveWait, Math.max(0, persisted.deadline - Date.now() + 5)),
    );
    const restored = await open(config, backend);
    expect(await restored.lookup(input)).toEqual({ kind: "started" });
    outage = false;
    await restored.drain();
    const terminal = await restored.lookup(input);
    expect(
      terminal.kind === "finished" &&
        terminal.result.kind === "failed" &&
        terminal.result.error.message,
    ).toContain("owned container was killed");
    expect(starts).toBe(1);
    expect(kills).toBe(1);
    expect(running).toBe(false);
    expect(await restored.start(input)).toEqual(terminal);
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
  const completion = Promise.withResolvers<SandboxExecutionResult>();
  const secondCompletion = Promise.withResolvers<SandboxExecutionResult>();
  const read = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let exports = 0;
  let starts = 0;

  const service = await open(
    config,
    {
      start: async () => {
        starts += 1;

        return starts === 1 ? completion.promise : secondCompletion.promise;
      },
      recover: async () => succeeded,
    },
    {
      cleanup: async () => {},
      read: async (receipt, path) => {
        exports += 1;
        expect(receipt.volume).toMatch(/^loopy-workspace-[a-f0-9]{64}$/);
        read.resolve();
        await release.promise;

        return {
          path,
          bytes: "aGk=",
          sha256: createHash("sha256").update("hi").digest("hex"),
          size: 2,
        };
      },
    },
  );

  const handler = attemptHandler(service, token);
  const input = request();
  expect((await handler(new Request(artifactLookup(input, "out.txt").url))).status).toBe(401);
  expect((await handler(artifactLookup(input, "out.txt"))).status).toBe(404);
  await service.start(input);
  expect((await handler(artifactLookup(input, "out.txt"))).status).toBe(409);
  completion.resolve(succeeded);
  await service.drain();

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
  expect(sandboxArtifactSchema.parse(await exported.json())).toMatchObject({
    path: "out.txt",
    size: 2,
    bytes: "aGk=",
  });
  expect(exports).toBe(1);
  await service.start({ ...input, attempt: 2 });
  expect((await handler(artifactLookup(input, "out.txt"))).status).toBe(409);
  expect(exports).toBe(1);
  secondCompletion.resolve(succeeded);
  await service.drain();
});

test("state roots reject symlinks and public binding; live root ownership is exclusive", async () => {
  const config = await fixture();
  expect(sandboxConfigSchema.safeParse({ ...config, hostname: "0.0.0.0" }).success).toBe(false);
  await expect(
    validateStateRoot({ ...config, stateRoot: join(config.worktree, "elsewhere") }),
  ).rejects.toThrow("<worktree>/.loopy/cloud/sandbox");
  const other = await fixture();
  await rm(join(other.stateRoot, "receipts"), { recursive: true });
  await symlink(config.stateRoot, join(other.stateRoot, "receipts"));
  await expect(validateStateRoot(other)).rejects.toThrow("without symlinks");
  const backend: AttemptBackend = { start: async () => succeeded, recover: async () => succeeded };
  await open(config, backend);
  await expect(Attempts.open(config, filesystemDependencies(config, { backend }))).rejects.toThrow(
    "Another sandbox service owns",
  );
});

test("process capture bounds actual bytes and terminates timed-out workers", async () => {
  await expect(
    runCommand([process.execPath, "-e", "process.stdout.write('x'.repeat(4096))"], {
      timeoutMs: 1000,
      maxBytes: 128,
    }),
  ).rejects.toMatchObject({ reason: "output_limit" });
  await expect(
    runCommand([process.execPath, "-e", "setTimeout(()=>{},10000)"], { timeoutMs: 20 }),
  ).rejects.toMatchObject({ reason: "timeout" });
});

test("loopback server serves health and an authenticated asynchronous attempt", async () => {
  const config = await fixture();
  const backend: AttemptBackend = { start: async () => succeeded, recover: async () => succeeded };
  const service = await startSandbox(config, filesystemDependencies(config, { backend }));

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
    await service.attempts.drain();
    expect(await service.attempts.lookup(input)).toEqual({ kind: "finished", result: succeeded });
  } finally {
    await service.close();
  }
});

test("concurrent restarts reclaim a dead process lock under one startup owner", async () => {
  const config = await fixture();

  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `import {lockStateRoot} from ${JSON.stringify(resolve(import.meta.dir, "../../../apps/sandbox/src/receipts.ts"))}; await lockStateRoot(${JSON.stringify(config.stateRoot)});`,
    ],
    {
      stdout: "ignore",
      stderr: "pipe",
    },
  );

  expect(await child.exited).toBe(0);
  const backend: AttemptBackend = { start: async () => succeeded, recover: async () => succeeded };

  const results = await Promise.allSettled([
    Attempts.open(config, filesystemDependencies(config, { backend })),
    Attempts.open(config, filesystemDependencies(config, { backend })),
  ]);

  expect(results.filter((result) => result.status === "fulfilled").length).toBe(1);
  expect(results.filter((result) => result.status === "rejected").length).toBe(1);

  for (const result of results) {
    if (result.status === "fulfilled") {
      services.push(result.value);
    }
  }
});

// BOUNDARY: Retained receipt JSON is parsed into the current or legacy record.
function decodeDiskReceipt(value: unknown) {
  const record = attemptRecordSchema.safeParse(value);

  return record.success
    ? { ...record.data.plan, kind: record.data.kind }
    : storedReceiptSchema.parse(value);
}

async function diskReceipts(root: string) {
  return Promise.all(
    (await readdir(join(root, "receipts")))
      .filter((name) => name.endsWith(".json"))
      .map(async (name) =>
        decodeDiskReceipt(JSON.parse(await readFile(join(root, "receipts", name), "utf8"))),
      ),
  );
}

async function cleanupDocker(config: Awaited<ReturnType<typeof fixture>>) {
  // Names come only from this fixture's durable receipts, never a daemon-wide listing.
  const receipts = await diskReceipts(config.stateRoot);

  for (const receipt of receipts) {
    for (const container of [
      receipt.container,
      `${receipt.container}-input`,
      `loopy-artifact-${receipt.id}`,
    ]) {
      await runCommand(["docker", "--context", config.dockerContext, "rm", "--force", container], {
        timeoutMs: 30_000,
        env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
      });
    }
  }

  for (const volume of new Set(
    receipts.flatMap((receipt) => [receipt.volume, receipt.inputVolume]),
  )) {
    const output = await runCommand(
      ["docker", "--context", config.dockerContext, "volume", "rm", volume],
      { timeoutMs: 30_000, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" } },
    );

    expect(output.exitCode).toBe(0);

    const remaining = await runCommand(
      [
        "docker",
        "--context",
        config.dockerContext,
        "volume",
        "ls",
        "--filter",
        `name=^${volume}$`,
        "--format",
        "{{.Name}}",
      ],
      { timeoutMs: 30_000, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" } },
    );

    expect(remaining.exitCode).toBe(0);
    expect(remaining.stdout.trim()).toBe("");
  }
}

const dockerContext = process.env.LOOPY_SANDBOX_DOCKER_CONTEXT;

test.skipIf(dockerContext !== "colima-loopy-cloud-phase1")(
  "real Docker preserves files, bounds execution, reconciles results and never repeats killed workers",
  async () => {
    const config = await fixture();
    config.maxTimeoutMs = 2000;
    const backend = new DockerBackend(config);
    const service = await open(config, backend);

    try {
      const value = request(
        `const input = await Bun.stdin.json(); process.stderr.write(JSON.stringify({message:'probe',data:input})+'\\n'); process.stdout.write('\\n'+JSON.stringify({uid:process.getuid(),home:process.env.HOME})+'\\n');`,
      );

      value.executionKey.runId = `sandbox-fixture-${randomUUID()}`;
      await service.start(value);
      await service.drain();
      expect(await service.lookup(value)).toEqual({
        kind: "finished",
        result: {
          kind: "succeeded",
          output: { uid: 1000, home: "/workspace" },
          logs: [{ message: "probe", data: {} }],
        },
      });
      const saved = (await diskReceipts(config.stateRoot))[0];

      if (!saved) {
        throw new Error("Expected a durable container identity.");
      }

      expect(await backend.recover({ ...saved, kind: "started" })).toEqual({
        kind: "succeeded",
        output: { uid: 1000, home: "/workspace" },
        logs: [{ message: "probe", data: {} }],
      });

      const first = sandboxAttemptRequestSchema.parse({
        ...value,
        attempt: 2,
        bundles: [],
        spec: commandSpec([
          "/bin/sh",
          "-c",
          "printf shared > shared.txt; mkdir -p artifacts; printf nested > artifacts/good.txt; ln -s /etc/passwd secret; ln -s artifacts alias; mkfifo pipe; head -c 1048577 /dev/zero > too-large",
        ]),
      });

      await service.start(first);
      await service.drain();

      const second = sandboxAttemptRequestSchema.parse({
        ...first,
        attempt: 3,
        spec: commandSpec(["/bin/cat", "shared.txt"]),
      });

      await service.start(second);
      await service.drain();
      const final = await service.lookup(second);
      expect(
        final.kind === "finished" && final.result.kind === "succeeded" && final.result.output,
      ).toEqual({ stdout: "shared", stderr: "", exitCode: 0 });
      const artifactHandler = attemptHandler(service, token);
      const exported = await artifactHandler(artifactLookup(first, "shared.txt"));
      expect(exported.status).toBe(200);
      expect(sandboxArtifactSchema.parse(await exported.json())).toEqual({
        path: "shared.txt",
        bytes: Buffer.from("shared").toString("base64"),
        sha256: createHash("sha256").update("shared").digest("hex"),
        size: 6,
      });
      const nested = await artifactHandler(artifactLookup(first, "artifacts/good.txt"));
      expect(nested.status).toBe(200);
      expect(sandboxArtifactSchema.parse(await nested.json()).bytes).toBe(
        Buffer.from("nested").toString("base64"),
      );

      for (const path of [
        "secret",
        "alias/good.txt",
        "pipe",
        "artifacts",
        "../shared.txt",
        "/etc/passwd",
      ]) {
        expect((await artifactHandler(artifactLookup(first, path))).status).toBe(400);
      }

      expect((await artifactHandler(artifactLookup(first, "missing"))).status).toBe(404);
      expect((await artifactHandler(artifactLookup(first, "too-large"))).status).toBe(413);
      expect((await diskReceipts(config.stateRoot)).length).toBe(3);

      const invalidCwd = sandboxAttemptRequestSchema.parse({
        ...second,
        attempt: 4,
        spec: { ...second.spec, cwd: "/etc" },
      });

      await service.start(invalidCwd);
      await service.drain();
      const cwdResult = await service.lookup(invalidCwd);
      expect(
        cwdResult.kind === "finished" &&
          cwdResult.result.kind === "failed" &&
          cwdResult.result.error.code,
      ).toBe("validation");

      const overflow = { ...request("process.stdout.write('x'.repeat(3*1024*1024))"), attempt: 5 };
      await service.start(overflow);
      await service.drain();
      const overflowResult = await service.lookup(overflow);
      expect(
        overflowResult.kind === "finished" &&
          overflowResult.result.kind === "failed" &&
          overflowResult.result.error.code,
      ).toBe("output_limit");

      const timeout = request("setTimeout(()=>{},30000)");

      if (timeout.spec.kind !== "code") {
        throw new Error("Expected code fixture.");
      }

      timeout.spec.timeoutMs = 30;
      timeout.attempt = 6;
      await service.start(timeout);
      await service.drain();
      const timeoutResult = await service.lookup(timeout);
      expect(
        timeoutResult.kind === "finished" &&
          timeoutResult.result.kind === "failed" &&
          timeoutResult.result.error.message,
      ).toContain("timed out");

      const killed = request("setTimeout(()=>{},30000)");

      if (killed.spec.kind !== "code") {
        throw new Error("Expected code fixture.");
      }

      killed.spec.timeoutMs = 30_000;
      killed.attempt = 7;
      await service.start(killed);

      const killedReceipt = (await diskReceipts(config.stateRoot)).find(
        (receipt) => receipt.attempt === 7,
      );

      if (!killedReceipt) {
        throw new Error("Expected worker identity before container start.");
      }

      let running = false;

      for (let i = 0; i < 50 && !running; i += 1) {
        const state = await runCommand(
          [
            "docker",
            "--context",
            config.dockerContext,
            "inspect",
            "--format",
            "{{.State.Running}}",
            killedReceipt.container,
          ],
          { timeoutMs: 1000, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" } },
        );

        running = state.exitCode === 0 && state.stdout.trim() === "true";

        if (!running) {
          await new Promise((resolveWait) => setTimeout(resolveWait, 50));
        }
      }

      expect(running).toBe(true);

      const terminated = await runCommand(
        ["docker", "--context", config.dockerContext, "kill", killedReceipt.container],
        { timeoutMs: 5000, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" } },
      );

      expect(terminated.exitCode).toBe(0);
      await service.drain();
      const killedResult = await service.lookup(killed);
      expect(
        killedResult.kind === "finished" &&
          killedResult.result.kind === "failed" &&
          killedResult.result.error.code,
      ).toBe("uncertain");
      expect(await service.start(killed)).toEqual(killedResult);

      const outerTimeout = { ...killed, attempt: 8 };
      await service.start(outerTimeout);
      await service.drain();
      const outerResult = await service.lookup(outerTimeout);
      expect(
        outerResult.kind === "finished" &&
          outerResult.result.kind === "failed" &&
          outerResult.result.error.message,
      ).toContain("owned container was killed");
      expect(await service.start(outerTimeout)).toEqual(outerResult);
    } finally {
      await service.drain();
      await cleanupDocker(config);
    }
  },
  60_000,
);
