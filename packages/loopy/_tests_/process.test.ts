import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { CommandExecutionError, executeCommand } from "../src/process.js";

const workspaces: string[] = [];
function workspace(): string {
  const path = mkdtempSync(join(tmpdir(), "loopy-process-"));
  workspaces.push(path);
  return path;
}

afterEach(() => {
  for (const path of workspaces.splice(0)) rmSync(path, { recursive: true, force: true });
});

const hasBubblewrap =
  process.platform === "linux" && (existsSync("/usr/bin/bwrap") || existsSync("/bin/bwrap"));

describe("process executor", () => {
  test("passes arguments literally and preserves a failing exit code", async () => {
    const cwd = workspace();
    const output = await executeCommand(
      { program: "/bin/echo", args: ["$(touch injected)", "; exit 2"] },
      { cwd, mode: "full" },
    );
    expect(output.stdout).toBe("$(touch injected) ; exit 2\n");
    expect(existsSync(join(cwd, "injected"))).toBe(false);

    const failed = await executeCommand(
      { program: process.execPath, args: ["-e", "process.exit(7)"] },
      { cwd, mode: "full" },
    );
    expect(failed.exitCode).toBe(7);
  });

  test("bounds combined output", async () => {
    try {
      await executeCommand(
        {
          program: process.execPath,
          args: [
            "-e",
            "process.stdout.write('a'.repeat(2048)); process.stderr.write('b'.repeat(2048))",
          ],
          maxOutputBytes: 100,
        },
        { cwd: workspace(), mode: "full" },
      );
      throw new Error("Expected output limit to stop the command");
    } catch (error) {
      expect(error).toBeInstanceOf(CommandExecutionError);
      const failure = error as CommandExecutionError;
      expect(failure.message).toContain("output exceeded 100 bytes");
      expect(failure.started).toBe(true);
      expect(
        Buffer.byteLength(failure.output.stdout) + Buffer.byteLength(failure.output.stderr),
      ).toBe(100);
    }
  });

  test("passes stdin and explicit environment values", async () => {
    const output = await executeCommand(
      {
        program: process.execPath,
        args: ["-e", "console.log(process.env.LOOPY_VALUE + ':' + await Bun.stdin.text())"],
        env: { LOOPY_VALUE: "input" },
        stdin: "hello",
      },
      { cwd: workspace(), mode: "full" },
    );
    expect(output.stdout).toBe("input:hello\n");
  });

  test("stops a timed out process and its descendants", async () => {
    const cwd = workspace();
    await expect(
      executeCommand(
        {
          program: "/bin/sh",
          args: ["-c", "(sleep 1; touch child-survived) & wait"],
          timeoutMs: 150,
        },
        { cwd, mode: "full" },
      ),
    ).rejects.toThrow("timed out");
    await Bun.sleep(1_200);
    expect(existsSync(join(cwd, "child-survived"))).toBe(false);
  });

  test("stops background children after a successful parent exit", async () => {
    const cwd = workspace();
    const output = await executeCommand(
      { program: "/bin/sh", args: ["-c", "(sleep 0.5; touch orphan) & exit 0"] },
      { cwd, mode: "full" },
    );
    expect(output.exitCode).toBe(0);
    await Bun.sleep(700);
    expect(existsSync(join(cwd, "orphan"))).toBe(false);
  });

  test("kills descendants that ignore termination", async () => {
    const cwd = workspace();
    await expect(
      executeCommand(
        {
          program: "/bin/sh",
          args: ["-c", "(trap '' TERM; sleep 0.5; touch ignored) & wait"],
          timeoutMs: 100,
        },
        { cwd, mode: "full" },
      ),
    ).rejects.toThrow("timed out");
    await Bun.sleep(700);
    expect(existsSync(join(cwd, "ignored"))).toBe(false);
  });

  test("honors cancellation", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    await expect(
      executeCommand(
        { program: process.execPath, args: ["-e", "setTimeout(() => {}, 10000)"] },
        { cwd: workspace(), mode: "full", signal: controller.signal },
      ),
    ).rejects.toThrow("aborted");
  });

  test.skipIf(process.platform !== "darwin")(
    "sandbox confines writes and rejects escaped directories",
    async () => {
      const cwd = workspace();
      const outside = workspace();
      const direct = await executeCommand(
        {
          program: process.execPath,
          args: ["-e", "require('node:fs').writeFileSync('inside', 'ok')"],
        },
        { cwd, mode: "sandbox" },
      );
      expect(direct.exitCode).toBe(0);
      expect(existsSync(join(cwd, "inside"))).toBe(true);

      const denied = await executeCommand(
        {
          program: process.execPath,
          args: [
            "-e",
            "require('node:fs').writeFileSync(process.argv[1], 'no')",
            join(outside, "escaped"),
          ],
        },
        { cwd, mode: "sandbox" },
      );
      expect(denied.exitCode).not.toBe(0);
      expect(existsSync(join(outside, "escaped"))).toBe(false);

      symlinkSync(join(outside, "linked-escape"), join(cwd, "file-link"));
      const linked = await executeCommand(
        {
          program: process.execPath,
          args: ["-e", "require('node:fs').writeFileSync('file-link', 'no')"],
        },
        { cwd, mode: "sandbox" },
      );
      expect(linked.exitCode).not.toBe(0);
      expect(existsSync(join(outside, "linked-escape"))).toBe(false);

      symlinkSync(outside, join(cwd, "link"));
      await expect(
        executeCommand(
          { program: "/bin/echo", args: ["hello"], cwd: "link" },
          { cwd, mode: "sandbox" },
        ),
      ).rejects.toThrow("outside the sandbox workspace");
    },
  );

  test.skipIf(process.platform !== "darwin")("sandbox denies network access", async () => {
    const cwd = workspace();
    const server = Bun.serve({ port: 0, fetch: () => new Response("reachable") });
    try {
      const command = {
        program: process.execPath,
        args: ["-e", `console.log(await (await fetch('http://127.0.0.1:${server.port}')).text())`],
        timeoutMs: 5_000,
      };
      expect((await executeCommand(command, { cwd, mode: "full" })).stdout).toContain("reachable");
      const denied = await executeCommand(command, { cwd, mode: "sandbox" });
      expect(denied.exitCode).not.toBe(0);
    } finally {
      server.stop(true);
    }
  });

  test.skipIf(process.platform !== "darwin" || !existsSync(join(homedir(), ".zshrc")))(
    "sandbox denies reads from the user's home outside the workspace",
    async () => {
      const cwd = workspace();
      const command = {
        program: process.execPath,
        args: [
          "-e",
          "require('node:fs').readFileSync(process.argv[1]); console.log('read')",
          join(homedir(), ".zshrc"),
        ],
      };
      expect((await executeCommand(command, { cwd, mode: "full" })).stdout).toContain("read");
      const denied = await executeCommand(command, { cwd, mode: "sandbox" });
      expect(denied.exitCode).not.toBe(0);
    },
  );

  test.skipIf(!hasBubblewrap)("Linux sandbox keeps a /tmp workspace writable", async () => {
    const cwd = mkdtempSync("/tmp/loopy-process-");
    const outside = mkdtempSync("/tmp/loopy-process-");
    workspaces.push(cwd, outside);
    const inside = await executeCommand(
      {
        program: process.execPath,
        args: ["-e", "require('node:fs').writeFileSync('inside', 'ok')"],
      },
      { cwd, mode: "sandbox" },
    );
    expect(inside.exitCode).toBe(0);
    expect(existsSync(join(cwd, "inside"))).toBe(true);

    const denied = await executeCommand(
      {
        program: process.execPath,
        args: [
          "-e",
          "require('node:fs').writeFileSync(process.argv[1], 'no')",
          join(outside, "escape"),
        ],
      },
      { cwd, mode: "sandbox" },
    );
    expect(denied.exitCode).not.toBe(0);
    expect(existsSync(join(outside, "escape"))).toBe(false);

    const server = Bun.serve({ port: 0, fetch: () => new Response("reachable") });
    try {
      const network = {
        program: process.execPath,
        args: ["-e", `console.log(await (await fetch('http://127.0.0.1:${server.port}')).text())`],
      };
      expect((await executeCommand(network, { cwd, mode: "full" })).stdout).toContain("reachable");
      expect((await executeCommand(network, { cwd, mode: "sandbox" })).exitCode).not.toBe(0);
    } finally {
      server.stop(true);
    }
  });
});
