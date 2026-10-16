import { readFile } from "node:fs/promises";
import type { Executor, ResolvedCommand } from "../src/runtime/index.js";
import type { CommandResult } from "../src/sdk/index.js";

export function result(stdout: string, exitCode = 0): CommandResult {
  return { stdout, stderr: "", exitCode, durationMs: 0 };
}

export function fixture(namespace: string, name: string, platform = "darwin") {
  return readFile(
    new URL(`./fixtures/shell/${namespace}/${name}.${platform}.txt`, import.meta.url),
    "utf8",
  );
}

export class SpawnExecutor implements Executor {
  async execute(command: ResolvedCommand, options: { workspace: string }): Promise<CommandResult> {
    const child = Bun.spawn([command.program, ...command.args], {
      cwd: command.cwd ?? options.workspace,
      env: { ...process.env, LC_ALL: "C", ...command.env },
      stdin: command.stdin === undefined ? "ignore" : new TextEncoder().encode(command.stdin),
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);

    return { stdout, stderr, exitCode, durationMs: 0 };
  }
}
