import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ShellNodeSchema, WorkflowDefinitionSchema } from "@loopy/contracts";
import { RuntimeScheduler } from "@loopy/runtime";
import { DeterministicFakeProvider, InMemoryRuntimeStore } from "../../testing/src/index";
import { createShellExecutor, shellEnvironment } from "../src/shell";

const node = (stages: string[]) =>
  ShellNodeSchema.parse({
    id: crypto.randomUUID(),
    name: "Pipeline",
    kind: "shell",
    stages,
    execution: "host",
  });
const context = (stages: string[], signal = new AbortController().signal) => ({
  runId: "run",
  attemptId: "attempt",
  nodeId: "shell",
  node: node(stages),
  input: { stdin: "one\ntwo\n" },
  signal,
});
test("pipes literal stdin through Bash stages and catches a failed middle stage", async () => {
  const executor = createShellExecutor({ workingDirectory: tmpdir() });
  const result = await executor.execute(context(["cat", "tr 'a-z' 'A-Z'", "head -n 1"]));
  expect(result).toMatchObject({ status: "succeeded", outputs: { stdout: "ONE\n", exitCode: 0 } });
  expect(await executor.execute(context(["cat", "exit 7", "cat"]))).toMatchObject({
    status: "failed",
    outputs: { exitCode: 7 },
  });
  const literal = context(["cat"]);
  literal.input.stdin = "$(touch /tmp/never-run-loopy-input)";
  expect(await executor.execute(literal)).toMatchObject({
    outputs: { stdout: literal.input.stdin },
  });
  expect(shellEnvironment()).not.toHaveProperty("BASH_ENV");
  expect(ShellNodeSchema.safeParse({ ...node(["cat"]), execution: undefined }).success).toBe(false);
});
test("bounds output and kills timed-out or cancelled pipeline descendants", async () => {
  const directory = mkdtempSync(join(tmpdir(), "loopy-pipeline-"));
  const executor = createShellExecutor({ workingDirectory: directory });
  try {
    const limited = context(["while true; do printf 1234567890; done"]);
    limited.node.maxOutputBytes = 512;
    expect(await executor.execute(limited)).toMatchObject({
      status: "failed",
      outputs: { truncated: true },
    });
    const timed = context(["sleep 30 & echo $! > child.pid; wait"]);
    timed.node.timeoutMs = 100;
    expect(await executor.execute(timed)).toMatchObject({
      status: "failed",
      outputs: { timedOut: true },
    });
    const pid = Number(readFileSync(join(directory, "child.pid"), "utf8"));
    let state = "";
    for (let attempt = 0; attempt < 20; attempt++) {
      const result = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)]);
      state = result.stdout.toString().trim();
      if (!state || state.startsWith("Z")) break;
      await Bun.sleep(20);
    }
    expect(!state || state.startsWith("Z")).toBe(true);
    const controller = new AbortController();
    const running = executor.execute(context(["sleep 30", "cat"], controller.signal));
    setTimeout(() => controller.abort(), 50);
    expect(await running).toMatchObject({ status: "cancelled" });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
test("the Loopy runtime retries a shell failure and persists each attempt's outputs", async () => {
  const directory = mkdtempSync(join(tmpdir(), "loopy-shell-retry-"));
  try {
    const shell = node([
      "if test -f retried; then printf recovered; else touch retried; exit 9; fi",
    ]);
    shell.retry = { maxAttempts: 2, backoffMs: 1, retryOn: [] };
    const fixture = await Bun.file(
      new URL("../../../fixtures/workflows/valid-basic.json", import.meta.url),
    ).json();
    const definition = WorkflowDefinitionSchema.parse({
      ...fixture,
      nodes: [shell],
      edges: [],
      inputs: [],
    });
    definition.policies.workspace = {
      workingDirectory: directory,
      writableRoots: [directory],
      useGitWorktree: false,
      allowDirtyWorkspace: true,
    };
    const runtime = new RuntimeScheduler({
      store: new InMemoryRuntimeStore(),
      provider: new DeterministicFakeProvider(),
      shell: createShellExecutor(),
    });
    const result = await runtime.run(definition);
    expect(result.run.status).toBe("succeeded");
    expect(result.attempts.map((attempt) => [attempt.status, attempt.output?.exitCode])).toEqual([
      ["failed", 9],
      ["succeeded", 0],
    ]);
    expect(result.attempts[1]?.output?.stdout).toBe("recovered");
    expect(result.events.filter((event) => event.type === "node.completed")).toHaveLength(2);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
