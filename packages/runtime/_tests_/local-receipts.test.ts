import { expect, test } from "bun:test";
import { lstat, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ExecutionResult } from "@loopy/core";
import { Effect } from "effect";
import { ExecutionWorker } from "../src/executor/execution";
import { FilesystemReceipts, type LocalReceipt, receiptPath } from "../src/executor/receipts";
import { receiptsFixture } from "./fixtures/local-receipts";
import { waitForFile } from "./fixtures/wait";

const result: ExecutionResult = { kind: "succeeded", output: 42, logs: [] };

test("filesystem claims are exclusive, private and retain the saved single-file format", async () => {
  const f = await receiptsFixture();
  expect(await Effect.runPromise(f.receipts.read(f.identity))).toBeNull();
  expect(await Effect.runPromise(f.receipts.claim(f.identity))).toEqual({ kind: "created" });
  expect(await Effect.runPromise(f.receipts.claim(f.identity))).toEqual({
    kind: "existing",
    receipt: { ...f.identity, kind: "started", pid: process.pid },
  });
  const path = await Effect.runPromise(receiptPath(f.home, f.key, 1));
  expect((await lstat(path)).mode & 0o777).toBe(0o600);
  expect((await lstat(dirname(path))).mode & 0o777).toBe(0o700);
  const finished = { ...f.identity, kind: "finished" as const, result };
  expect(await Effect.runPromise(f.receipts.finish(finished))).toEqual(finished);
  const bytes = await readFile(path, "utf8");
  const reopened = new FilesystemReceipts(f.home);
  expect(await Effect.runPromise(reopened.read(f.identity))).toEqual(finished);
  expect(await Effect.runPromise(reopened.claim(f.identity))).toEqual({
    kind: "existing",
    receipt: finished,
  });
  expect(
    await Effect.runPromise(
      reopened.finish({ ...finished, result: { ...result, output: "replacement" } }),
    ),
  ).toEqual(finished);
  expect(await readFile(path, "utf8")).toBe(bytes);
});

test("saved started and finished receipts decode without rewriting, corruption fails closed", async () => {
  const f = await receiptsFixture();
  const path = await Effect.runPromise(receiptPath(f.home, f.key, 1));

  const values = [
    { ...f.identity, kind: "started", pid: process.pid },
    { ...f.identity, kind: "finished", result },
    {
      ...f.identity,
      kind: "finished",
      result: {
        kind: "failed",
        error: { code: "uncertain", message: "Stopped worker" },
        exitCode: null,
        logs: [],
      },
    },
  ] satisfies LocalReceipt[];

  for (const value of values) {
    const bytes = `${JSON.stringify(value, null, 2)}\n`;
    await writeFile(path, bytes);
    expect(await Effect.runPromise(f.receipts.read(f.identity))).toEqual(value);
    expect(await readFile(path, "utf8")).toBe(bytes);
  }

  await writeFile(path, "{");
  await expect(Effect.runPromise(f.receipts.read(f.identity))).rejects.toMatchObject({
    _tag: "ExecutorError",
  });
  await expect(Effect.runPromise(f.receipts.claim(f.identity))).rejects.toMatchObject({
    _tag: "ExecutorError",
  });
});

test("receipt reads reject a saved foreign execution identity or attempt", async () => {
  const f = await receiptsFixture();
  const path = await Effect.runPromise(receiptPath(f.home, f.key, 1));

  for (const identity of [
    { ...f.identity, executionKey: { ...f.key, runId: "foreign" } },
    { ...f.identity, attempt: 2 },
  ]) {
    await writeFile(path, JSON.stringify({ ...identity, kind: "finished", result }));
    await expect(Effect.runPromise(f.executor.lookup(f.key, 1))).rejects.toMatchObject({
      _tag: "ExecutorError",
      cause: expect.objectContaining({
        message: "Receipt identity does not match this execution attempt.",
      }),
    });
  }
});

test("receipt directories reject symlinks and encode traversal run ids", async () => {
  const f = await receiptsFixture();
  await symlink(f.workspace, join(f.home, "receipts"));
  await expect(Effect.runPromise(f.receipts.claim(f.identity))).rejects.toMatchObject({
    _tag: "ExecutorError",
    cause: expect.objectContaining({
      message: "Receipt directories must be real directories inside the daemon home.",
    }),
  });
  const isolated = new FilesystemReceipts(join(f.root, "isolated-home"));
  const identity = { ...f.identity, executionKey: { ...f.key, runId: "../outside" } };
  expect(await Effect.runPromise(isolated.claim(identity))).toEqual({ kind: "created" });
  expect(await Effect.runPromise(isolated.read(identity))).toMatchObject({
    ...identity,
    kind: "started",
  });
});

test("unclaimed work cannot publish a terminal receipt", async () => {
  const f = await receiptsFixture();
  await expect(
    Effect.runPromise(f.receipts.finish({ ...f.identity, kind: "finished", result })),
  ).rejects.toMatchObject({
    _tag: "ExecutorError",
    cause: expect.objectContaining({
      message: "Execution has no claimed receipt. Claim it before performing work.",
    }),
  });
  expect(await Effect.runPromise(f.receipts.read(f.identity))).toBeNull();
});

test("two execution workers sharing a receipt perform the side effect once", async () => {
  const f = await receiptsFixture();
  await writeFile(
    f.bundle,
    'const {appendFile} = await import("node:fs/promises"); await appendFile("effect", "once\\n"); console.log(42);',
  );

  const worker = () =>
    new ExecutionWorker({
      home: f.home,
      workspace: f.workspace,
      mode: "sandbox",
      secrets: [],
      bundles: { [f.spec.kind === "code" ? f.spec.bundleHash : ""]: f.bundle },
    });

  const outcomes = await Promise.allSettled([
    Effect.runPromise(worker().execute(f.key, 1, f.spec, new AbortController().signal)),
    Effect.runPromise(worker().execute(f.key, 1, f.spec, new AbortController().signal)),
  ]);

  expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
  expect(await readFile(join(f.workspace, "effect"), "utf8")).toBe("once\n");
  expect(await Effect.runPromise(f.receipts.read(f.identity))).toMatchObject({
    kind: "finished",
    result: { kind: "succeeded", output: 42 },
  });
});

test("competing local parents cannot give two trusted children the same effect", async () => {
  const f = await receiptsFixture();
  await writeFile(
    f.bundle,
    'const {appendFile} = await import("node:fs/promises"); await appendFile("effect", "once\\n"); await Bun.sleep(100); console.log(42);',
  );

  const outcomes = await Promise.allSettled([
    Effect.runPromise(f.executor.execute(f.key, 1, f.spec, new AbortController().signal)),
    Effect.runPromise(f.executor.execute(f.key, 1, f.spec, new AbortController().signal)),
  ]);

  expect(
    outcomes.some(
      (outcome) => outcome.status === "fulfilled" && outcome.value.kind === "succeeded",
    ),
  ).toBe(true);
  expect(await readFile(join(f.workspace, "effect"), "utf8")).toBe("once\n");
  expect(await Effect.runPromise(f.receipts.read(f.identity))).toMatchObject({
    kind: "finished",
    result: { kind: "succeeded", output: 42 },
  });
});

test("a live trusted child retains completion authority, a killed child becomes uncertain", async () => {
  const f = await receiptsFixture();
  await writeFile(
    f.bundle,
    // On macOS the bundle outlives its killed worker until released, then completes as an orphan.
    // It reports completion through a file because on Linux its pid lives in the sandbox's PID namespace.
    'await Bun.write("effect", "once"); while (!(await Bun.file("release").exists())) { await Bun.sleep(10); } await Bun.write("done", "released"); console.log(42);',
  );

  const completion = Effect.runPromise(
    f.executor.execute(f.key, 1, f.spec, new AbortController().signal),
  ).then(
    () => "resolved",
    () => "rejected",
  );

  await waitForFile(join(f.workspace, "effect"));
  const receipt = await Effect.runPromise(f.receipts.read(f.identity));

  if (receipt?.kind !== "started") {
    throw new Error("Expected a live trusted child receipt.");
  }

  try {
    expect(await Bun.file(join(f.workspace, "effect")).exists()).toBe(true);
    expect(await Effect.runPromise(f.executor.lookup(f.key, 1))).toEqual({ kind: "started" });
    await expect(
      Effect.runPromise(f.receipts.finish({ ...f.identity, kind: "finished", result })),
    ).rejects.toMatchObject({
      _tag: "ExecutorError",
      cause: expect.objectContaining({
        message: "Execution worker is still alive. Reconcile its receipt before finishing.",
      }),
    });
    process.kill(receipt.pid, "SIGKILL");
    expect(await completion).toBe("rejected");
    const terminal = await Effect.runPromise(f.executor.lookup(f.key, 1));
    expect(terminal).toMatchObject({
      kind: "finished",
      result: {
        kind: "failed",
        error: { code: "uncertain" },
      },
    });

    if (terminal.kind !== "finished") {
      throw new Error("Expected a terminal uncertainty receipt.");
    }

    expect(
      await Effect.runPromise(f.executor.execute(f.key, 1, f.spec, new AbortController().signal)),
    ).toEqual(terminal.result);
    await writeFile(join(f.workspace, "release"), "release");

    // Bubblewrap runs Linux bundles with --die-with-parent, so only macOS leaves an orphan to wait for.
    if (process.platform === "darwin") {
      await waitForFile(join(f.workspace, "done"));
    }

    expect(await readFile(join(f.workspace, "effect"), "utf8")).toBe("once");
    expect(await Effect.runPromise(f.executor.lookup(f.key, 1))).toEqual(terminal);
  } finally {
    try {
      process.kill(receipt.pid, "SIGKILL");
    } catch (cause) {
      if (!(cause instanceof Error && "code" in cause && cause.code === "ESRCH")) {
        throw cause;
      }
    }

    await completion;
  }
});

for (const competing of [false, true]) {
  test(`a paused claim write stays invisible and publishes exclusively, competitor ${competing}`, async () => {
    const f = await receiptsFixture();
    const ready = join(f.root, "claim-ready");
    const release = join(f.root, "claim-release");
    const path = await Effect.runPromise(receiptPath(f.home, f.key, 1));

    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        join(import.meta.dir, "fixtures/paused-receipt-claim.ts"),
      ],
      {
        cwd: f.workspace,
        env: { PATH: process.env.PATH, HOME: f.home, LOOPY_HOME: f.home },
        stdin: new Response(JSON.stringify({ home: f.home, identity: f.identity, ready, release })),
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    try {
      await waitForFile(ready);
      expect(await Bun.file(path).exists()).toBe(false);
      expect(await Effect.runPromise(f.receipts.read(f.identity))).toBeNull();

      if (competing) {
        expect(await Effect.runPromise(f.receipts.claim(f.identity))).toEqual({ kind: "created" });
      }

      await Bun.write(release, "publish");
      expect(await child.exited).toBe(0);
      expect(await new Response(child.stderr).text()).toBe("");
      expect(JSON.parse(await new Response(child.stdout).text())).toMatchObject({
        kind: competing ? "existing" : "created",
      });
      expect(await Effect.runPromise(f.receipts.read(f.identity))).toEqual({
        ...f.identity,
        kind: "started",
        pid: competing ? process.pid : child.pid,
      });
      expect(await readdir(dirname(path))).toEqual(["1.json"]);
    } finally {
      await Bun.write(release, "release fixture");
      child.kill("SIGKILL");
      await child.exited;
    }
  });
}
