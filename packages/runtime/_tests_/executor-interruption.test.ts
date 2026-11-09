import { expect, test } from "bun:test";
import { chmod, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Cause, Effect, Fiber, Schema } from "effect";
import { ExecutionWorker } from "../src/executor/execution";
import { FilesystemReceipts } from "../src/executor/receipts";
import { commandSpec, fixture } from "./fixtures/executor";
import { onCleanup } from "./fixtures/test-scope";
import { waitForExit, waitForFile } from "./fixtures/wait";

const activeProgram =
  'require("node:fs").appendFileSync("runs", "x"); await Bun.write("ready.json", JSON.stringify({pid: process.pid})); await Bun.write("ready", "ready"); setInterval(() => {}, 1000);';

async function waitForAuthor(workspace: string) {
  await waitForFile(join(workspace, "ready"));

  return Schema.decodeUnknownSync(Schema.Struct({ pid: Schema.Number }))(
    await Bun.file(join(workspace, "ready.json")).json(),
  );
}

for (const kind of ["command", "code", "parser"] as const) {
  test(`${kind} abort retains the typed failure and leaves its receipt started`, async () => {
    const f = await fixture();
    await writeFile(f.bundle, activeProgram);

    const spec =
      kind === "code"
        ? { ...f.spec, timeoutMs: 10000 }
        : commandSpec(
            kind === "command" ? [process.execPath, "-e", activeProgram] : ["/bin/echo", "fixture"],
          );

    if (kind === "parser" && spec.kind === "command") {
      spec.parse = { bundleHash: "a".repeat(64), timeoutMs: 300_000 };
    }

    const receipts = new FilesystemReceipts(f.home);

    const executor = new ExecutionWorker({
      home: f.home,
      workspace: f.workspace,
      mode: "sandbox",
      secrets: [],
      bundles: { ["a".repeat(64)]: f.bundle },
    });

    const controller = new AbortController();

    const running = Effect.runPromise(
      executor.execute(f.key, 1, spec, controller.signal).pipe(Effect.exit),
    );

    try {
      const author = await waitForAuthor(f.workspace);
      controller.abort();
      const exit = await running;
      expect(exit).toMatchObject({ _tag: "Failure" });

      if (exit._tag !== "Failure") {
        throw new Error("Expected infrastructure failure.");
      }

      expect(exit.cause.reasons).toContainEqual(
        expect.objectContaining({
          _tag: "Fail",
          error: expect.objectContaining({
            _tag: "ExecutorError",
            cause: expect.objectContaining({ _tag: "CommandExecutionError", reason: "aborted" }),
          }),
        }),
      );
      expect(
        await Effect.runPromise(receipts.read({ executionKey: f.key, attempt: 1 })),
      ).toMatchObject({ kind: "started", pid: process.pid });
      expect(() => process.kill(author.pid, 0)).toThrow();
      expect(await readFile(join(f.workspace, "runs"), "utf8")).toBe("x");
    } finally {
      controller.abort();
      await running;
    }
  });

  test(`${kind} fiber interruption joins the worker and preserves a started receipt until reconciliation`, async () => {
    const f = await fixture();
    await writeFile(f.bundle, activeProgram);

    const spec =
      kind === "code"
        ? { ...f.spec, timeoutMs: 10000 }
        : commandSpec(
            kind === "command" ? [process.execPath, "-e", activeProgram] : ["/bin/echo", "fixture"],
          );

    if (kind === "parser" && spec.kind === "command") {
      spec.parse = { bundleHash: "a".repeat(64), timeoutMs: 300_000 };
    }

    const receipts = new FilesystemReceipts(f.home);

    const running = Effect.runFork(
      f.executor.execute(f.key, 1, spec, new AbortController().signal),
    );

    try {
      const author = await waitForAuthor(f.workspace);
      const claimed = await Effect.runPromise(receipts.read({ executionKey: f.key, attempt: 1 }));

      if (claimed?.kind !== "started") {
        throw new Error("Expected an active worker claim.");
      }

      await Effect.runPromise(Fiber.interrupt(running));
      const exit = await Effect.runPromise(Fiber.await(running));

      if (exit._tag !== "Failure") {
        throw new Error("Expected interrupted execution.");
      }

      expect(Cause.hasInterrupts(exit.cause)).toBe(true);
      expect(() => process.kill(claimed.pid, 0)).toThrow();
      expect(() => process.kill(author.pid, 0)).toThrow();
      expect(
        await Effect.runPromise(receipts.read({ executionKey: f.key, attempt: 1 })),
      ).toMatchObject({ kind: "started", pid: claimed.pid });
      expect(await Effect.runPromise(f.executor.lookup(f.key, 1))).toMatchObject({
        kind: "finished",
        result: { kind: "failed", error: { code: "uncertain" } },
      });
      expect(
        await Effect.runPromise(f.executor.execute(f.key, 1, spec, new AbortController().signal)),
      ).toMatchObject({ kind: "failed", error: { code: "uncertain" } });
      expect(await readFile(join(f.workspace, "runs"), "utf8")).toBe("x");
    } finally {
      await Effect.runPromise(Fiber.interrupt(running));
    }
  });

  test(`a signalled ${kind} worker stops its author, and the caller seals the attempt as uncertain without replay`, async () => {
    const f = await fixture();
    await writeFile(f.bundle, activeProgram);

    const spec =
      kind === "code"
        ? { ...f.spec, timeoutMs: 10000 }
        : commandSpec(
            kind === "command" ? [process.execPath, "-e", activeProgram] : ["/bin/echo", "fixture"],
          );

    if (kind === "parser" && spec.kind === "command") {
      spec.parse = { bundleHash: "a".repeat(64), timeoutMs: 300_000 };
    }

    const receipts = new FilesystemReceipts(f.home);

    const controller = new AbortController();

    const running = Effect.runPromise(
      Effect.exit(f.executor.execute(f.key, 1, spec, controller.signal)),
    );

    onCleanup(async () => {
      controller.abort();
      await running;
    });
    const author = await waitForAuthor(f.workspace);
    const claimed = await Effect.runPromise(receipts.read({ executionKey: f.key, attempt: 1 }));

    if (claimed?.kind !== "started") {
      throw new Error("Expected an active worker claim.");
    }

    process.kill(claimed.pid, kind === "parser" ? "SIGINT" : "SIGTERM");
    const exit = await running;
    expect(exit).toMatchObject({
      _tag: "Failure",
      cause: {
        reasons: [{ _tag: "Fail", error: { _tag: "ExecutorError", operation: "execute" } }],
      },
    });
    await waitForExit(claimed.pid);
    expect(() => process.kill(author.pid, 0)).toThrow();
    expect(await Effect.runPromise(f.executor.lookup(f.key, 1))).toMatchObject({
      kind: "finished",
      result: { kind: "failed", error: { code: "uncertain" } },
    });
    expect(
      await Effect.runPromise(f.executor.execute(f.key, 1, spec, new AbortController().signal)),
    ).toMatchObject({ kind: "failed", error: { code: "uncertain" } });
    expect(await readFile(join(f.workspace, "runs"), "utf8")).toBe("x");
  });
}

test("an already durable completion wins over an aborted caller", async () => {
  const f = await fixture();
  await writeFile(f.bundle, 'console.log("42");');

  const completed = await Effect.runPromise(
    f.executor.execute(f.key, 1, f.spec, new AbortController().signal),
  );

  const controller = new AbortController();
  controller.abort();
  expect(await Effect.runPromise(f.executor.execute(f.key, 1, f.spec, controller.signal))).toEqual(
    completed,
  );
  expect(completed).toMatchObject({ kind: "succeeded", output: 42 });
});

test("aborted command with failed cleanup preserves both causes and never finishes its receipt", async () => {
  const f = await fixture();

  const spec = commandSpec([
    process.execPath,
    "-e",
    'const fs = require("node:fs"); const locked = process.env.TMPDIR + "/locked"; fs.mkdirSync(locked); fs.writeFileSync(locked + "/file", "fixture"); fs.chmodSync(locked, 0); await Bun.write("scratch", process.env.TMPDIR); await Bun.write("ready.json", JSON.stringify({pid: process.pid})); await Bun.write("ready", "ready"); setInterval(() => {}, 1000);',
  ]);

  const receipts = new FilesystemReceipts(f.home);

  const executor = new ExecutionWorker({
    home: f.home,
    workspace: f.workspace,
    mode: "sandbox",
    secrets: [],
    bundles: { ["a".repeat(64)]: f.bundle },
  });

  const controller = new AbortController();

  const running = Effect.runPromise(
    executor.execute(f.key, 1, spec, controller.signal).pipe(Effect.exit),
  );

  let scratch: string | undefined;

  try {
    const author = await waitForAuthor(f.workspace);
    scratch = Schema.decodeUnknownSync(Schema.NonEmptyString)(
      await readFile(join(f.workspace, "scratch"), "utf8"),
    );
    controller.abort();
    const exit = await running;

    if (exit._tag !== "Failure") {
      throw new Error("Expected interrupted process and failed cleanup.");
    }

    expect(exit.cause.reasons).toContainEqual(
      expect.objectContaining({
        _tag: "Fail",
        error: expect.objectContaining({
          _tag: "ExecutorError",
          cause: expect.objectContaining({ _tag: "CommandExecutionError", reason: "aborted" }),
        }),
      }),
    );
    expect(exit.cause.reasons).toContainEqual(
      expect.objectContaining({
        _tag: "Fail",
        error: expect.objectContaining({
          _tag: "ExecutorError",
          cause: expect.objectContaining({
            _tag: "ScratchCleanupError",
            cause: expect.objectContaining({ _tag: "ProcessFilesystemError" }),
          }),
        }),
      }),
    );
    expect(
      await Effect.runPromise(receipts.read({ executionKey: f.key, attempt: 1 })),
    ).toMatchObject({ kind: "started" });
    expect(() => process.kill(author.pid, 0)).toThrow();
  } finally {
    controller.abort();
    await running;

    if (scratch !== undefined) {
      await chmod(join(scratch, "locked"), 0o700);
      await rm(scratch, { recursive: true, force: true });
    }
  }
});
