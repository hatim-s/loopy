import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Effect, Schema } from "effect";
import { LocalExecutor } from "../src/executor";
import { receiptPath } from "../src/executor/receipts";
import { SecretStore } from "../src/os/secrets";
import { commandSpec, fixture } from "./fixtures/executor";
import { onCleanup } from "./fixtures/test-scope";
import { until, waitForFile } from "./fixtures/wait";

test("code protocol captures stderr logs and leading stdout, and retains its trusted completion receipt", async () => {
  const f = await fixture();
  await writeFile(
    f.bundle,
    `const input = await Bun.stdin.json(); process.stdout.write("noise\\n"); process.stderr.write(JSON.stringify({message: "hello", data: input}) + "\\n"); process.stdout.write(JSON.stringify({input})+"\\n");`,
  );
  expect(await Effect.runPromise(f.executor.lookup(f.key, 1))).toEqual({ kind: "none" });

  const result = await Effect.runPromise(
    f.executor.execute(f.key, 1, f.spec, new AbortController().signal),
  );

  expect(result).toEqual({
    kind: "succeeded",
    output: { input: { name: "Hatim" } },
    logs: [
      { message: "hello", data: { name: "Hatim" } },
      { message: "stdout", data: "noise\n" },
    ],
  });
  expect(await Effect.runPromise(f.executor.lookup(f.key, 1))).toMatchObject({
    kind: "finished",
    result,
  });
  expect(
    await Effect.runPromise(f.executor.execute(f.key, 1, f.spec, new AbortController().signal)),
  ).toEqual(result);
});

test("code sandbox cannot read a sibling host file or write outside the workspace in either mode", async () => {
  const f = await fixture();
  const privateFile = join(f.root, "private.ts");
  await writeFile(privateFile, "export default 'private';");
  await writeFile(
    f.bundle,
    `let read = false, write = false, imported = false; try {await Bun.file(${JSON.stringify(privateFile)}).text(); read = true;} catch {} try {await Bun.write(${JSON.stringify(join(f.root, "escape"))}, "bad"); write = true;} catch {} try {await import(${JSON.stringify(privateFile)}); imported = true;} catch {} process.stdout.write(JSON.stringify({read, write, imported})+"\\n");`,
  );

  for (const [index, mode] of ["sandbox", "full"].entries()) {
    if (mode !== "sandbox" && mode !== "full") {
      throw new Error("Unknown mode.");
    }

    const executor = new LocalExecutor({
      home: join(f.root, "home"),
      workspace: f.workspace,
      mode,
      secrets: [],
      bundlePath: () => f.bundle,
    });

    expect(
      await Effect.runPromise(
        executor.execute(f.key, index + 1, f.spec, new AbortController().signal),
      ),
    ).toMatchObject({ kind: "succeeded", output: { read: false, write: false, imported: false } });
  }
});

test("timeout terminates the process group including an inherited grandchild", async () => {
  const f = await fixture();
  await writeFile(
    f.bundle,
    `const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {stdout: "inherit", stderr: "inherit"}); await Bun.write("child.pid", String(child.pid)); setInterval(() => {}, 1000);`,
  );

  // The timeout must outlast bun startup on a loaded machine, or no grandchild exists to check.
  const result = await Effect.runPromise(
    f.executor.execute(f.key, 1, { ...f.spec, timeoutMs: 2000 }, new AbortController().signal),
  );

  expect(result).toMatchObject({
    kind: "failed",
    error: { code: "execution", message: expect.stringContaining("timed out") },
  });
  const pid = Number(await readFile(join(f.workspace, "child.pid"), "utf8"));
  expect(() => process.kill(pid, 0)).toThrow();
});

test("a worker finishes its receipt after the caller process is killed", async () => {
  const f = await fixture();
  // The bundle finishes only after the caller is gone, so the worker must outlive its caller.
  await writeFile(
    f.bundle,
    'while (!(await Bun.file("release").exists())) { await Bun.sleep(10); } process.stdout.write("42\\n");',
  );
  const { home, workspace, bundle, key, spec } = f;

  const caller = Bun.spawn(
    [process.execPath, "--no-env-file", resolve(import.meta.dir, "fixtures/executor-caller.ts")],
    {
      stdin: new Response(JSON.stringify({ home, workspace, bundle, key, spec })),
      stdout: "ignore",
      stderr: "ignore",
    },
  );

  onCleanup(async () => {
    caller.kill();
    await caller.exited;
  });

  await until(
    "the worker to claim its receipt",
    async () => (await Effect.runPromise(f.executor.lookup(f.key, 1))).kind === "started",
  );
  caller.kill("SIGKILL");
  await caller.exited;
  await writeFile(join(f.workspace, "release"), "release");

  // Execute waits for the surviving worker's receipt instead of running the attempt again.
  expect(
    await Effect.runPromise(f.executor.execute(f.key, 1, f.spec, new AbortController().signal)),
  ).toMatchObject({ kind: "succeeded", output: 42 });
});

test("only declared secrets reach bundles and receipts contain redacted results and logs", async () => {
  const f = await fixture();
  const home = join(f.root, "home");
  const secrets = new SecretStore(home);
  await Effect.runPromise(secrets.set("LOOPY_EXPOSED", "super-private"));
  await Effect.runPromise(secrets.set("LOOPY_UNDECLARED", "also-private"));
  await writeFile(
    f.bundle,
    'process.stderr.write(JSON.stringify({message: process.env.LOOPY_EXPOSED,data:null})+"\\n"); process.stdout.write(JSON.stringify({token:process.env.LOOPY_EXPOSED,other:process.env.LOOPY_UNDECLARED ?? null})+"\\n");',
  );

  const executor = new LocalExecutor({
    home,
    workspace: f.workspace,
    mode: "sandbox",
    secrets: ["LOOPY_EXPOSED"],
    bundlePath: () => f.bundle,
  });

  expect(
    await Effect.runPromise(executor.execute(f.key, 1, f.spec, new AbortController().signal)),
  ).toMatchObject({
    kind: "succeeded",
    output: { token: "[redacted]", other: null },
    logs: [{ message: "[redacted]", data: null }],
  });
  expect(
    await readFile(await Effect.runPromise(receiptPath(join(f.root, "home"), f.key, 1)), "utf8"),
  ).not.toContain("super-private");
});

for (const problem of ["secret", "bundle"] as const) {
  test(`worker ${problem} preparation fails through the infrastructure channel before claiming`, async () => {
    const f = await fixture();

    const executor = new LocalExecutor({
      home: f.home,
      workspace: f.workspace,
      mode: "sandbox",
      secrets: problem === "secret" ? ["MISSING_FIXTURE_SECRET"] : [],
      bundlePath: () => join(f.home, "missing.js"),
    });

    const result = await Effect.runPromise(
      executor.execute(f.key, 1, f.spec, new AbortController().signal).pipe(Effect.result),
    );

    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "ExecutorError", operation: problem === "secret" ? "secret" : "execute" },
    });
    expect(await Effect.runPromise(executor.lookup(f.key, 1))).toEqual({ kind: "none" });
  });
}

test("pre-aborted execution does not launch or claim a worker", async () => {
  const f = await fixture();
  const controller = new AbortController();
  controller.abort();

  const result = await Effect.runPromise(
    f.executor.execute(f.key, 1, f.spec, controller.signal).pipe(Effect.result),
  );

  expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "ExecutorError" } });
  expect(await Effect.runPromise(f.executor.lookup(f.key, 1))).toEqual({ kind: "none" });
});

test("worker abort returns infrastructure failure and reconciles to nonretryable uncertainty", async () => {
  const f = await fixture();
  await writeFile(f.bundle, 'await Bun.write("ready", "ready"); setInterval(() => {}, 1000);');
  const controller = new AbortController();

  const running = Effect.runPromise(
    f.executor
      .execute(f.key, 1, { ...f.spec, timeoutMs: 10000 }, controller.signal)
      .pipe(Effect.result),
  );

  try {
    await waitForFile(join(f.workspace, "ready"));
    controller.abort();
    const result = await running;
    expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "ExecutorError" } });
    expect(await Effect.runPromise(f.executor.lookup(f.key, 1))).toMatchObject({
      kind: "finished",
      result: { kind: "failed", error: { code: "uncertain" } },
    });
  } finally {
    controller.abort();
    await running.catch(() => {});
  }
});

test("scratch cleanup failure preserves the known command result and records a redacted diagnostic", async () => {
  const f = await fixture();

  const spec = commandSpec([
    "/bin/sh",
    "-c",
    'mkdir "$TMPDIR/locked"; touch "$TMPDIR/locked/file"; chmod 000 "$TMPDIR/locked"; printf %s "$TMPDIR"',
  ]);

  let scratch: string | undefined;

  try {
    const result = await Effect.runPromise(
      f.executor.execute(f.key, 1, spec, new AbortController().signal),
    );

    if (result.kind !== "succeeded") {
      throw new Error("Expected captured command output.");
    }

    const output = Schema.decodeUnknownSync(
      Schema.Struct({ stdout: Schema.String, stderr: Schema.String, exitCode: Schema.Number }),
    )(result.output);

    scratch = output.stdout;
    expect(result.logs).toContainEqual(expect.objectContaining({ message: "cleanup" }));
    expect(await Effect.runPromise(f.executor.lookup(f.key, 1))).toMatchObject({
      kind: "finished",
      result,
    });
  } finally {
    if (scratch !== undefined) {
      await chmod(join(scratch, "locked"), 0o700);
      await rm(scratch, { recursive: true, force: true });
    }
  }
});

test("a post-claim staging failure stays infrastructure and seals the attempt against replay", async () => {
  const f = await fixture();

  const executor = new LocalExecutor({
    home: f.home,
    workspace: f.workspace,
    mode: "sandbox",
    secrets: [],
    bundlePath: () => f.home,
  });

  const result = await Effect.runPromise(
    executor.execute(f.key, 1, f.spec, new AbortController().signal).pipe(Effect.result),
  );

  expect(result).toMatchObject({
    _tag: "Failure",
    failure: { _tag: "ExecutorError", cause: { message: expect.stringContaining("copyfile") } },
  });
  expect(await Effect.runPromise(executor.lookup(f.key, 1))).toMatchObject({
    kind: "finished",
    result: { kind: "failed", error: { code: "uncertain" } },
  });
  expect(
    await Effect.runPromise(executor.execute(f.key, 1, f.spec, new AbortController().signal)),
  ).toMatchObject({ kind: "failed", error: { code: "uncertain" } });
});

for (const problem of ["program", "cwd", "env", "loop", "flags"] as const) {
  test(`invalid author ${problem} retains its durable execution diagnostic`, async () => {
    const f = await fixture();
    const program = join(f.workspace, "loop");

    if (problem === "loop") {
      await symlink("loop", program);
    }

    const spec = commandSpec(
      problem === "program"
        ? ["/missing-fixture-program"]
        : problem === "loop"
          ? [program]
          : ["/bin/echo", "ok"],
    );

    if (spec.kind !== "command") {
      throw new Error("Expected command fixture.");
    }

    if (problem === "cwd") {
      spec.cwd = "missing-fixture-directory";
    }

    if (problem === "env") {
      spec.env = { "INVALID=NAME": "fixture" };
    }

    if (problem === "flags") {
      spec.flags = { unknownFixtureFlag: true };
    }

    const result = await Effect.runPromise(
      f.executor.execute(f.key, 1, spec, new AbortController().signal),
    );

    expect(result).toMatchObject({ kind: "failed", error: { code: "execution" } });

    if (problem === "program") {
      expect(result).toMatchObject({
        error: { message: expect.stringContaining("was not found") },
      });
    }

    expect(await Effect.runPromise(f.executor.lookup(f.key, 1))).toMatchObject({
      kind: "finished",
      result,
    });
  });
}

test("a timed-out command retains output and cleanup diagnostics together", async () => {
  const f = await fixture();

  const spec = commandSpec([
    "/bin/sh",
    "-c",
    'mkdir "$TMPDIR/locked"; touch "$TMPDIR/locked/file"; chmod 000 "$TMPDIR/locked"; printf %s "$TMPDIR"; sleep 10',
  ]);

  if (spec.kind !== "command") {
    throw new Error("Expected command fixture.");
  }

  spec.timeoutMs = 2000;
  let scratch: string | undefined;

  try {
    const result = await Effect.runPromise(
      f.executor.execute(f.key, 1, spec, new AbortController().signal),
    );

    const stdout = result.logs.find((log) => log.message === "stdout");
    scratch = Schema.decodeUnknownSync(Schema.NonEmptyString)(stdout?.data);
    expect(result).toMatchObject({
      kind: "failed",
      error: { code: "execution", message: expect.stringContaining("timed out") },
    });
    expect(result.logs).toContainEqual(expect.objectContaining({ message: "cleanup" }));
    expect(await Effect.runPromise(f.executor.lookup(f.key, 1))).toMatchObject({
      kind: "finished",
      result,
    });
  } finally {
    if (scratch !== undefined) {
      if (existsSync(join(scratch, "locked"))) {
        await chmod(join(scratch, "locked"), 0o700);
      }

      await rm(scratch, { recursive: true, force: true });
    }
  }
});
