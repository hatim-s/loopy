import { expect, test } from "bun:test";
import { lstat, readFile, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ExecutionResult } from "../src/core/index.js";
import { ExecutionWorker } from "../src/executor/execution.js";
import { LocalExecutor } from "../src/executor/local.js";
import { FilesystemReceipts, type LocalReceipt, receiptPath } from "../src/executor/receipts.js";
import { receiptsFixture } from "./fixtures/local-receipts.js";

const result: ExecutionResult = { kind: "succeeded", output: 42, logs: [] };

test("filesystem claims are exclusive, private and retain the saved single-file format", async () => {
  const f = await receiptsFixture();
  expect(await f.receipts.read(f.identity)).toBeNull();
  expect(await f.receipts.claim(f.identity)).toEqual({ kind: "created" });
  expect(await f.receipts.claim(f.identity)).toEqual({
    kind: "existing",
    receipt: { ...f.identity, kind: "started", pid: process.pid },
  });
  const path = await receiptPath(f.home, f.key, 1);
  expect((await lstat(path)).mode & 0o777).toBe(0o600);
  expect((await lstat(dirname(path))).mode & 0o777).toBe(0o700);
  const finished = { ...f.identity, kind: "finished" as const, result };
  expect(await f.receipts.finish(finished)).toEqual(finished);
  const bytes = await readFile(path, "utf8");
  const reopened = new FilesystemReceipts(f.home);
  expect(await reopened.read(f.identity)).toEqual(finished);
  expect(await reopened.claim(f.identity)).toEqual({ kind: "existing", receipt: finished });
  expect(
    await reopened.finish({ ...finished, result: { ...result, output: "replacement" } }),
  ).toEqual(finished);
  expect(await readFile(path, "utf8")).toBe(bytes);
});

test("saved started and finished receipts decode without rewriting, corruption fails closed", async () => {
  const f = await receiptsFixture();
  const path = await receiptPath(f.home, f.key, 1);

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
    expect(await f.receipts.read(f.identity)).toEqual(value);
    expect(await readFile(path, "utf8")).toBe(bytes);
  }

  await writeFile(path, "{");
  await expect(f.receipts.read(f.identity)).rejects.toBeInstanceOf(SyntaxError);
  await expect(f.receipts.claim(f.identity)).rejects.toBeInstanceOf(SyntaxError);
});

test("receipt reads reject a saved foreign execution identity or attempt", async () => {
  const f = await receiptsFixture();
  const path = await receiptPath(f.home, f.key, 1);

  for (const identity of [
    { ...f.identity, executionKey: { ...f.key, runId: "foreign" } },
    { ...f.identity, attempt: 2 },
  ]) {
    await writeFile(path, JSON.stringify({ ...identity, kind: "finished", result }));
    await expect(f.executor.lookup(f.key, 1)).rejects.toThrow(
      "Receipt identity does not match this execution attempt.",
    );
  }
});

test("receipt directories reject symlinks and encode traversal run ids", async () => {
  const f = await receiptsFixture();
  await symlink(f.workspace, join(f.home, "receipts"));
  await expect(f.receipts.claim(f.identity)).rejects.toThrow(
    "Receipt directories must be real directories inside the daemon home.",
  );
  const isolated = new FilesystemReceipts(join(f.root, "isolated-home"));
  const identity = { ...f.identity, executionKey: { ...f.key, runId: "../outside" } };
  expect(await isolated.claim(identity)).toEqual({ kind: "created" });
  expect(await isolated.read(identity)).toMatchObject({ ...identity, kind: "started" });
});

test("unclaimed work cannot publish a terminal receipt", async () => {
  const f = await receiptsFixture();
  await expect(f.receipts.finish({ ...f.identity, kind: "finished", result })).rejects.toThrow(
    "Execution has no claimed receipt. Claim it before performing work.",
  );
  expect(await f.receipts.read(f.identity)).toBeNull();
});

test("two execution workers sharing a receipt perform the side effect once", async () => {
  const f = await receiptsFixture();
  await writeFile(
    f.bundle,
    'const {appendFile} = await import("node:fs/promises"); await appendFile("effect", "once\\n"); console.log(42);',
  );

  const worker = () =>
    new ExecutionWorker({
      ...f,
      mode: "sandbox",
      secrets: [],
      bundlePath: () => f.bundle,
      receipts: f.receipts,
    });

  const outcomes = await Promise.allSettled([
    worker().execute(f.key, 1, f.spec, new AbortController().signal),
    worker().execute(f.key, 1, f.spec, new AbortController().signal),
  ]);

  expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
  expect(await readFile(join(f.workspace, "effect"), "utf8")).toBe("once\n");
  expect(await f.receipts.read(f.identity)).toMatchObject({
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
    f.executor.execute(f.key, 1, f.spec, new AbortController().signal),
    f.executor.execute(f.key, 1, f.spec, new AbortController().signal),
  ]);

  expect(
    outcomes.some(
      (outcome) => outcome.status === "fulfilled" && outcome.value.kind === "succeeded",
    ),
  ).toBe(true);
  expect(await readFile(join(f.workspace, "effect"), "utf8")).toBe("once\n");
  expect(await f.receipts.read(f.identity)).toMatchObject({
    kind: "finished",
    result: { kind: "succeeded", output: 42 },
  });
});

test("trusted child receives a parsed descriptor instead of the injected receipt object", async () => {
  const f = await receiptsFixture();
  Object.assign(f.receipts, { cannotSerialize: 1n });
  await writeFile(f.bundle, "console.log(42);");
  const completed = await f.executor.execute(f.key, 1, f.spec, new AbortController().signal);
  expect(completed).toMatchObject({ kind: "succeeded", output: 42 });
  expect(await f.receipts.read(f.identity)).toMatchObject({ kind: "finished", result: completed });
  expect(
    () =>
      new LocalExecutor({
        ...f,
        mode: "sandbox",
        secrets: [],
        bundlePath: () => f.bundle,
        receipts: new FilesystemReceipts(f.workspace),
      }),
  ).toThrow("Execution receipts must use the protected daemon home.");
});

test("a live trusted child retains completion authority, a killed child becomes uncertain", async () => {
  const f = await receiptsFixture();
  await writeFile(
    f.bundle,
    'await Bun.write("effect", "once"); await Bun.sleep(1500); console.log(42);',
  );

  const completion = f.executor.execute(f.key, 1, f.spec, new AbortController().signal).then(
    () => "resolved",
    () => "rejected",
  );

  for (
    let index = 0;
    index < 200 && !(await Bun.file(join(f.workspace, "effect")).exists());
    index++
  ) {
    await Bun.sleep(10);
  }

  const receipt = await f.receipts.read(f.identity);

  if (receipt?.kind !== "started") {
    throw new Error("Expected a live trusted child receipt.");
  }

  try {
    expect(await Bun.file(join(f.workspace, "effect")).exists()).toBe(true);
    expect(await f.executor.lookup(f.key, 1)).toEqual({ kind: "started" });
    await expect(f.receipts.finish({ ...f.identity, kind: "finished", result })).rejects.toThrow(
      "Execution worker is still alive. Reconcile its receipt before finishing.",
    );
    process.kill(receipt.pid, "SIGKILL");
    expect(await completion).toBe("rejected");
    const terminal = await f.executor.lookup(f.key, 1);
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

    expect(await f.executor.execute(f.key, 1, f.spec, new AbortController().signal)).toEqual(
      terminal.result,
    );
    await Bun.sleep(1600);
    expect(await readFile(join(f.workspace, "effect"), "utf8")).toBe("once");
    expect(await f.executor.lookup(f.key, 1)).toEqual(terminal);
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
