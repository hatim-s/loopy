import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineCommand } from "../src/command";
import { Runtime } from "../src/runtime";
import { trigger } from "../src/workflow";

const typedTool = defineCommand({
  program: "tool",
  positionals: [{ name: "target" }],
  flags: {
    mode: { cli: "--mode", kind: "string", choices: ["safe", "fast"] },
    timeout: { cli: "--timeout", kind: "number" },
    inspect: { cli: "--inspect", kind: "number", optionalValue: true, attachedValue: true },
  },
});

const workflow = trigger<{
  mode: "safe" | "fast";
  timeout: number;
  inspect: number;
  target: string;
}>("typed")
  .node("execute", ({ input }) =>
    typedTool({
      args: [input.target],
      flags: { mode: input.mode, timeout: input.timeout, inspect: input.inspect },
    }),
  )
  .build();

test("serialized CLI constraints reject invalid run input before invoking the tool", async () => {
  const home = mkdtempSync(join(tmpdir(), "loopy-command-"));
  const calls: string[][] = [];
  const runtime = new Runtime({
    home,
    executor: async (command) => {
      calls.push(command.args);
      return { stdout: "ok", stderr: "", exitCode: 0, durationMs: 1 };
    },
  });
  const base = { mode: "safe", timeout: 3, inspect: 9229, target: "-needle" };
  try {
    for (const [input, expectedError] of [
      [{ ...base, mode: "unsafe" }, "safe, fast"],
      [{ ...base, timeout: "later" }, "number"],
      [{ ...base, inspect: "later" }, "number"],
      [{ ...base, inspect: "9229" }, "number"],
      [{ ...base, target: 42 }, "string"],
    ] as const) {
      const run = runtime.createRun(workflow, input, { cwd: home, mode: "full" });
      const result = await runtime.execute(run.id);
      expect(result.status).toBe("failed");
      expect(result.error).toContain(expectedError);
      expect(runtime.getAttempts(run.id)[0]?.status).toBe("failed");
    }
    expect(calls).toHaveLength(0);

    const run = runtime.createRun(workflow, base, { cwd: home, mode: "full" });
    expect((await runtime.execute(run.id)).status).toBe("succeeded");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("--inspect=9229");
    expect(calls[0]).toContain("-needle");
  } finally {
    runtime.close();
    rmSync(home, { recursive: true, force: true });
  }
});
