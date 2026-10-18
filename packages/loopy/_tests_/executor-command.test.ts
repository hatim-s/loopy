import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { LocalExecutor } from "../src/executor/index.js";
import { receiptPath } from "../src/executor/receipts.js";
import { activate } from "../src/host/index.js";
import { SecretStore } from "../src/local/index.js";
import { loopy, sh } from "../src/sdk/graph/index.js";
import { MemoryStore } from "../src/store/index.js";
import { newRun } from "./fixture.js";
import { commandSpec, fixture } from "./fixtures/executor.js";

for (const mode of ["sandbox", "full"] as const) {
  test(`${mode} commands receive only declared secrets and redact stdout, stderr, errors and receipts`, async () => {
    const f = await fixture();
    const secrets = new SecretStore(f.home);
    await secrets.set("TOKEN", 'private"with\nnewline');
    await secrets.set("OTHER", "undeclared");

    const executor = new LocalExecutor({
      home: f.home,
      workspace: f.workspace,
      mode,
      secrets: Object.fromEntries(
        ["TOKEN"].map((name) => [name, new SecretStore(f.home).get(name)]),
      ),
      bundlePath: () => f.bundle,
    });

    const spec = commandSpec([
      "/bin/sh",
      "-c",
      'printf %s "$TOKEN"; printf %s "$TOKEN" >&2; test -z "$OTHER" || exit 99; exit 2',
    ]);

    const result = await executor.execute(f.key, 1, spec, new AbortController().signal);
    expect(result).toEqual({
      kind: "failed",
      error: {
        code: "exit",
        message: "Command exited with code 2: [redacted]. Inspect stderr and correct the command.",
      },
      exitCode: 2,
      logs: [
        { message: "stdout", data: "[redacted]" },
        { message: "stderr", data: "[redacted]" },
      ],
    });
    expect(await readFile(await receiptPath(f.home, f.key, 1), "utf8")).not.toContain("private");
  });

  test(`${mode} commands cannot read or replace daemon receipts`, async () => {
    const f = await fixture();
    const receipt = await receiptPath(f.home, f.key, 1);

    const executor = new LocalExecutor({
      home: f.home,
      workspace: f.workspace,
      mode,
      secrets: {},
      bundlePath: () => f.bundle,
    });

    const spec = commandSpec([
      "/bin/sh",
      "-c",
      'test ! -r "$1" && ! printf forged > "$1"',
      "probe",
      receipt,
    ]);

    expect(await executor.execute(f.key, 1, spec, new AbortController().signal)).toMatchObject({
      kind: "succeeded",
      output: { exitCode: 0 },
    });
    expect(await executor.lookup(f.key, 1)).toMatchObject({
      kind: "finished",
      result: { kind: "succeeded" },
    });
  });
}

for (const stderr of ["", `${"x".repeat(600)}last failure`]) {
  test("command exit errors omit empty stderr and retain its last 500 characters", async () => {
    const f = await fixture();
    const spec = commandSpec(["/bin/sh", "-c", 'printf %s "$1" >&2; exit 1', "probe", stderr]);

    const expected = stderr
      ? `Command exited with code 1: ${stderr.slice(-500)}. Inspect stderr and correct the command.`
      : "Command exited with code 1. Correct the command.";

    expect(await f.executor.execute(f.key, 1, spec, new AbortController().signal)).toMatchObject({
      kind: "failed",
      exitCode: 1,
      error: { code: "exit", message: expected },
    });
  });
}

test("literal command arguments retain shell characters without evaluation", async () => {
  const f = await fixture();
  expect(
    await f.executor.execute(
      f.key,
      1,
      commandSpec(["printf", "%s", "hello ; $HOME"]),
      new AbortController().signal,
    ),
  ).toMatchObject({ kind: "succeeded", output: { stdout: "hello ; $HOME", exitCode: 0 } });
});

test("stderr secrets are redacted before the diagnostic tail is trimmed", async () => {
  const f = await fixture();
  await new SecretStore(f.home).set("TOKEN", `start-${"private".repeat(100)}-end`);

  const executor = new LocalExecutor({
    home: f.home,
    workspace: f.workspace,
    mode: "sandbox",
    secrets: Object.fromEntries(["TOKEN"].map((name) => [name, new SecretStore(f.home).get(name)])),
    bundlePath: () => f.bundle,
  });

  const spec = commandSpec(["/bin/sh", "-c", 'printf %s "$TOKEN" >&2; exit 2']);
  expect(await executor.execute(f.key, 1, spec, new AbortController().signal)).toMatchObject({
    kind: "failed",
    error: {
      message: "Command exited with code 2: [redacted]. Inspect stderr and correct the command.",
    },
  });
});

for (const accepted of [false, true]) {
  test(`declared successful exit codes are checked before parser execution, accepted=${accepted}`, async () => {
    const f = await fixture();
    await writeFile(
      f.bundle,
      'const {result} = await Bun.stdin.json(); process.stdout.write(JSON.stringify({parsedExit: result.exitCode}) + "\\n");',
    );
    const spec = commandSpec(["/bin/sh", "-c", "exit 2"]);

    if (spec.kind !== "command") {
      throw new Error("Expected command spec");
    }

    spec.okExitCodes = accepted ? [0, 2] : [0];
    spec.parse = { bundleHash: "a".repeat(64), input: {} };
    const result = await f.executor.execute(f.key, 1, spec, new AbortController().signal);
    expect(result).toMatchObject(
      accepted
        ? { kind: "succeeded", output: { parsedExit: 2 } }
        : { kind: "failed", error: { code: "exit" }, exitCode: 2 },
    );
  });
}

test("parser execution failures propagate to the stored graph node and run", async () => {
  const f = await fixture();
  await writeFile(f.bundle, 'throw new Error("Parser rejected command output");');

  const graph = loopy("parser-failure", {
    input: {},
    run: () => sh(["printf", "raw"], { retry: { attempts: 1 } }),
  }).graph;

  const node = graph.nodes.find((node) => node.kind === "command");

  if (node?.kind !== "command") {
    throw new Error("Expected command node");
  }

  node.parse = { bundleHash: "a".repeat(64), input: {} };
  const store = new MemoryStore();
  await store.createRun(newRun());
  expect(await activate({ store, executor: f.executor, graph, runId: "run" })).toMatchObject({
    status: "failed",
    error: expect.stringContaining("Parser rejected command output"),
  });
  expect((await store.getNodeRuns("run"))[0]).toMatchObject({
    status: "failed",
    attempt: 1,
    error: {
      code: "execution",
      message: expect.stringContaining("Parser rejected command output"),
    },
  });
  expect(await store.getLogs("run")).toContainEqual(
    expect.objectContaining({ message: "stdout", data: "raw" }),
  );
});
