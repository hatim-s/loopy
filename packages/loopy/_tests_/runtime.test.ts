import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { CommandOutput, ExecuteCommand, Workflow } from "../src/model";
import { CommandExecutionError } from "../src/process";
import { Runtime } from "../src/runtime";
import { RunBusyError } from "../src/store";

const directories: string[] = [];
const runtimes: Runtime[] = [];

function fixture(executor?: ExecuteCommand) {
  const home = mkdtempSync(join(tmpdir(), "loopy-runtime-"));
  directories.push(home);
  const runtime = new Runtime({ home, executor });
  runtimes.push(runtime);
  return { home, runtime, options: { cwd: home, mode: "full" as const } };
}

afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const output = (stdout: string, exitCode = 0): CommandOutput => ({
  stdout,
  stderr: "",
  exitCode,
  durationMs: 1,
});

describe("durable workflow runtime", () => {
  test("runs a real argv command and records its output", async () => {
    const { runtime, options } = fixture();
    const run = runtime.createRun(
      {
        version: 1,
        slug: "real-command",
        nodes: [
          {
            id: "print",
            kind: "command",
            command: { program: process.execPath, args: ["-e", "process.stdout.write('hello')"] },
          },
        ],
      },
      {},
      options,
    );
    expect((await runtime.execute(run.id)).status).toBe("succeeded");
    expect(runtime.getAttempts(run.id)[0]?.output).toMatchObject({ stdout: "hello", exitCode: 0 });
  });

  test("persists resolved inputs and outputs, then retries only the failed node", async () => {
    const calls: string[] = [];
    let fail = true;
    const executor: ExecuteCommand = async (command) => {
      calls.push(`${command.program} ${command.args.join(" ")}`);
      if (command.program === "second" && fail) {
        fail = false;
        return output("try again", 9);
      }
      return output(command.args.join(" "));
    };
    const { home, runtime, options } = fixture(executor);
    const workflow: Workflow = {
      version: 1,
      slug: "retry",
      nodes: [
        {
          id: "first",
          kind: "command",
          command: { program: "first", args: [{ $ref: { source: "input", path: ["name"] } }] },
        },
        {
          id: "second",
          kind: "command",
          command: {
            program: "second",
            args: [{ $ref: { source: "steps", path: ["first", "stdout"] } }],
          },
        },
      ],
    };
    const run = runtime.createRun(workflow, { name: "Ada" }, options);
    expect((await runtime.execute(run.id)).status).toBe("failed");
    expect(runtime.getAttempts(run.id).map((attempt) => attempt.input)).toEqual([
      { program: "first", args: ["Ada"] },
      { program: "second", args: ["Ada"] },
    ]);
    runtime.close();
    runtimes.splice(runtimes.indexOf(runtime), 1);
    const resumed = new Runtime({ home, executor });
    runtimes.push(resumed);
    expect((await resumed.execute(run.id)).status).toBe("succeeded");
    expect(calls).toEqual(["first Ada", "second Ada", "second Ada"]);
    expect(resumed.getAttempts(run.id).map((attempt) => attempt.status)).toEqual([
      "succeeded",
      "failed",
      "succeeded",
    ]);
    expect(resumed.getEvents(run.id).map((event) => event.sequence)).toEqual(
      Array.from({ length: resumed.getEvents(run.id).length }, (_, index) => index),
    );
  });

  test("uses the workflow snapshot even after the source definition changes", async () => {
    const programs: string[] = [];
    const { runtime, options } = fixture(async (command) => {
      programs.push(command.program);
      return output("ok");
    });
    const workflow: Workflow = {
      version: 1,
      slug: "snapshot",
      nodes: [{ id: "one", kind: "command", command: { program: "original", args: [] } }],
    };
    const run = runtime.createRun(workflow, {}, options);
    const sourceNode = workflow.nodes[0];
    if (sourceNode?.kind === "command") sourceNode.command.program = "changed";
    expect((await runtime.execute(run.id)).status).toBe("succeeded");
    expect(programs).toEqual(["original"]);
    expect(runtime.getRun(run.id)?.workflowHash).toBe(run.workflowHash);
  });

  test("records a failed attempt when a command input cannot be resolved", async () => {
    const { runtime, options } = fixture(async () => output("unexpected"));
    const run = runtime.createRun(
      {
        version: 1,
        slug: "missing-input",
        nodes: [
          {
            id: "effect",
            kind: "command",
            command: {
              program: "tool",
              args: [{ $ref: { source: "input", path: ["absent"] } }],
            },
          },
        ],
      },
      {},
      options,
    );
    expect((await runtime.execute(run.id)).status).toBe("failed");
    expect(runtime.getAttempts(run.id)).toMatchObject([
      {
        nodeId: "effect",
        status: "failed",
        input: {
          command: { program: "tool", args: [{ $ref: { source: "input", path: ["absent"] } }] },
        },
      },
    ]);
  });

  test("keeps partial output when a started command is interrupted", async () => {
    const { runtime, options } = fixture(async () => {
      throw new CommandExecutionError("Timed out", output("partial", -1), true);
    });
    const run = runtime.createRun(
      {
        version: 1,
        slug: "partial-output",
        nodes: [{ id: "effect", kind: "command", command: { program: "tool", args: [] } }],
      },
      {},
      options,
    );
    expect((await runtime.execute(run.id)).status).toBe("interrupted");
    expect(runtime.getAttempts(run.id)[0]).toMatchObject({
      status: "uncertain",
      output: { stdout: "partial", exitCode: -1 },
    });
  });

  test("records a chosen branch and resumes past it", async () => {
    const calls: string[] = [];
    let fail = true;
    const { runtime, options } = fixture(async (command) => {
      calls.push(command.program);
      if (command.program === "tail" && fail) {
        fail = false;
        return output("", 1);
      }
      return output(command.program);
    });
    const workflow: Workflow = {
      version: 1,
      slug: "branch",
      nodes: [
        {
          id: "choice",
          kind: "condition",
          test: { $op: "eq", args: [{ $ref: { source: "input", path: ["kind"] } }, "yes"] },
          // biome-ignore lint/suspicious/noThenProperty: The workflow format names its true branch `then`.
          then: [{ id: "yes", kind: "command", command: { program: "yes", args: [] } }],
          else: [{ id: "no", kind: "command", command: { program: "no", args: [] } }],
        },
        { id: "tail", kind: "command", command: { program: "tail", args: [] } },
      ],
    };
    const run = runtime.createRun(workflow, { kind: "yes" }, options);
    expect((await runtime.execute(run.id)).status).toBe("failed");
    expect((await runtime.execute(run.id)).status).toBe("succeeded");
    expect(calls).toEqual(["yes", "tail", "tail"]);
    expect(runtime.getAttempts(run.id).find((item) => item.nodeId === "choice")?.output).toEqual({
      branch: "then",
    });
    expect(runtime.getAttempts(run.id).some((item) => item.nodeId === "no")).toBe(false);
  });

  test("does not allow two active owners for the same run", async () => {
    let release!: (value: CommandOutput) => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const executor: ExecuteCommand = () => {
      started();
      return new Promise<CommandOutput>((resolve) => {
        release = resolve;
      });
    };
    const { home, runtime, options } = fixture(executor);
    const second = new Runtime({ home, executor });
    runtimes.push(second);
    const run = runtime.createRun(
      {
        version: 1,
        slug: "owned",
        nodes: [{ id: "one", kind: "command", command: { program: "x", args: [] } }],
      },
      {},
      options,
    );
    const running = runtime.execute(run.id);
    await entered;
    await expect(second.execute(run.id)).rejects.toBeInstanceOf(RunBusyError);
    release(output("done"));
    expect((await running).status).toBe("succeeded");
  });

  test("marks a crashed command uncertain and requires explicit retry", async () => {
    const { home, runtime, options } = fixture(async () => output("retried"));
    const marker = join(home, "started");
    const runtimeUrl = pathToFileURL(join(import.meta.dir, "../src/runtime.ts")).href;
    const live = runtime.createRun(
      {
        version: 1,
        slug: "crash-live",
        nodes: [
          {
            id: "effect",
            kind: "command",
            command: {
              program: process.execPath,
              args: [
                "-e",
                `require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setInterval(() => {}, 1000)`,
              ],
            },
          },
        ],
      },
      {},
      options,
    );
    const source = `import { Runtime } from ${JSON.stringify(runtimeUrl)}; const runtime = new Runtime({home:${JSON.stringify(home)}}); await runtime.execute(${JSON.stringify(live.id)});`;
    const child = Bun.spawn([process.execPath, "-e", source], { stdout: "pipe", stderr: "pipe" });
    try {
      for (let count = 0; count < 100 && !existsSync(marker); count += 1) await Bun.sleep(20);
      expect(existsSync(marker)).toBe(true);
    } finally {
      child.kill("SIGKILL");
      await child.exited;
      if (existsSync(marker)) {
        const pid = Number(readFileSync(marker, "utf8"));
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          // The command may already have exited.
        }
      }
    }
    runtime.close();
    runtimes.splice(runtimes.indexOf(runtime), 1);
    const reopened = new Runtime({ home, executor: async () => output("retried") });
    runtimes.push(reopened);
    expect(reopened.getRun(live.id)?.status).toBe("interrupted");
    expect(reopened.getAttempts(live.id).map((attempt) => attempt.status)).toEqual(["uncertain"]);
    expect((await reopened.execute(live.id)).status).toBe("interrupted");
    expect(reopened.getAttempts(live.id)).toHaveLength(1);
    expect((await reopened.execute(live.id, { retryUncertain: true })).status).toBe("succeeded");
    expect(reopened.getAttempts(live.id).map((attempt) => attempt.status)).toEqual([
      "uncertain",
      "succeeded",
    ]);
  });
});
