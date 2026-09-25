import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { CommandExecutionError, executeLocalCommand } from "../src/local/process.js";

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
    const output = await executeLocalCommand(
      { program: "/bin/echo", args: ["$(touch injected)", "; exit 2"] },
      { workspace: { kind: "local", path: cwd }, mode: "full" },
    );
    expect(output.stdout).toBe("$(touch injected) ; exit 2\n");
    expect(existsSync(join(cwd, "injected"))).toBe(false);

    const failed = await executeLocalCommand(
      { program: process.execPath, args: ["-e", "process.exit(7)"] },
      { workspace: { kind: "local", path: cwd }, mode: "full" },
    );
    expect(failed.exitCode).toBe(7);
  });

  test("resolves relative PATH entries from the command directory", async () => {
    const cwd = workspace();
    mkdirSync(join(cwd, "tools"));
    const executable = join(cwd, "tools", "probe-cmd");
    writeFileSync(executable, "#!/bin/sh\necho expected\n");
    chmodSync(executable, 0o755);

    const output = await executeLocalCommand(
      { program: "probe-cmd", args: [], env: { PATH: "tools" } },
      { workspace: { kind: "local", path: cwd }, mode: "full" },
    );
    expect(output.stdout).toBe("expected\n");
  });

  test("bounds combined output", async () => {
    try {
      await executeLocalCommand(
        {
          program: process.execPath,
          args: [
            "-e",
            "process.stdout.write('a'.repeat(2048)); process.stderr.write('b'.repeat(2048))",
          ],
          maxOutputBytes: 100,
        },
        { workspace: { kind: "local", path: workspace() }, mode: "full" },
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
    const output = await executeLocalCommand(
      {
        program: process.execPath,
        args: ["-e", "console.log(process.env.LOOPY_VALUE + ':' + await Bun.stdin.text())"],
        env: { LOOPY_VALUE: "input" },
        stdin: "hello",
      },
      { workspace: { kind: "local", path: workspace() }, mode: "full" },
    );
    expect(output.stdout).toBe("input:hello\n");
  });

  test("stops a timed out process and its descendants", async () => {
    const cwd = workspace();
    await expect(
      executeLocalCommand(
        {
          program: "/bin/sh",
          args: ["-c", "(sleep 1; touch child-survived) & wait"],
          timeoutMs: 150,
        },
        { workspace: { kind: "local", path: cwd }, mode: "full" },
      ),
    ).rejects.toThrow("timed out");
    await Bun.sleep(1_200);
    expect(existsSync(join(cwd, "child-survived"))).toBe(false);
  });

  test("stops background children after a successful parent exit", async () => {
    const cwd = workspace();
    const output = await executeLocalCommand(
      { program: "/bin/sh", args: ["-c", "(sleep 0.5; touch orphan) & exit 0"] },
      { workspace: { kind: "local", path: cwd }, mode: "full" },
    );
    expect(output.exitCode).toBe(0);
    await Bun.sleep(700);
    expect(existsSync(join(cwd, "orphan"))).toBe(false);
  });

  test("settles when a separate session inherits output pipes", async () => {
    const cwd = workspace();
    const started = Date.now();
    const source = `
      const { spawn } = require("node:child_process");
      const child = spawn("/bin/sh", ["-c", "sleep 2"], {
        detached: true,
        stdio: ["ignore", "inherit", "inherit"],
      });
      child.unref();
    `;
    await expect(
      executeLocalCommand(
        { program: process.execPath, args: ["-e", source], timeoutMs: 100 },
        { workspace: { kind: "local", path: cwd }, mode: "full" },
      ),
    ).rejects.toThrow("timed out");
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  test("kills descendants that ignore termination", async () => {
    const cwd = workspace();
    await expect(
      executeLocalCommand(
        {
          program: "/bin/sh",
          args: ["-c", "(trap '' TERM; sleep 0.5; touch ignored) & wait"],
          timeoutMs: 100,
        },
        { workspace: { kind: "local", path: cwd }, mode: "full" },
      ),
    ).rejects.toThrow("timed out");
    await Bun.sleep(700);
    expect(existsSync(join(cwd, "ignored"))).toBe(false);
  });

  test("honors cancellation", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    await expect(
      executeLocalCommand(
        { program: process.execPath, args: ["-e", "setTimeout(() => {}, 10000)"] },
        {
          workspace: { kind: "local", path: workspace() },
          mode: "full",
          signal: controller.signal,
        },
      ),
    ).rejects.toThrow("aborted");
  });

  test.skipIf(process.platform !== "darwin")(
    "sandbox confines writes and rejects escaped directories",
    async () => {
      const cwd = workspace();
      const outside = workspace();
      const direct = await executeLocalCommand(
        {
          program: process.execPath,
          args: ["-e", "require('node:fs').writeFileSync('inside', process.env.LOOPY_TEST_VALUE)"],
          env: { LOOPY_TEST_VALUE: "ok" },
        },
        { workspace: { kind: "local", path: cwd }, mode: "sandbox" },
      );
      expect(direct.exitCode).toBe(0);
      expect(readFileSync(join(cwd, "inside"), "utf8")).toBe("ok");

      const denied = await executeLocalCommand(
        {
          program: process.execPath,
          args: [
            "-e",
            "require('node:fs').writeFileSync(process.argv[1], 'no')",
            join(outside, "escaped"),
          ],
        },
        { workspace: { kind: "local", path: cwd }, mode: "sandbox" },
      );
      expect(denied.exitCode).not.toBe(0);
      expect(existsSync(join(outside, "escaped"))).toBe(false);

      symlinkSync(join(outside, "linked-escape"), join(cwd, "file-link"));
      const linked = await executeLocalCommand(
        {
          program: process.execPath,
          args: ["-e", "require('node:fs').writeFileSync('file-link', 'no')"],
        },
        { workspace: { kind: "local", path: cwd }, mode: "sandbox" },
      );
      expect(linked.exitCode).not.toBe(0);
      expect(existsSync(join(outside, "linked-escape"))).toBe(false);

      symlinkSync(outside, join(cwd, "link"));
      await expect(
        executeLocalCommand(
          { program: "/bin/echo", args: ["hello"], cwd: "link" },
          { workspace: { kind: "local", path: cwd }, mode: "sandbox" },
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
      expect(
        (
          await executeLocalCommand(command, {
            workspace: { kind: "local", path: cwd },
            mode: "full",
          })
        ).stdout,
      ).toContain("reachable");
      const denied = await executeLocalCommand(command, {
        workspace: { kind: "local", path: cwd },
        mode: "sandbox",
      });
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
      expect(
        (
          await executeLocalCommand(command, {
            workspace: { kind: "local", path: cwd },
            mode: "full",
          })
        ).stdout,
      ).toContain("read");
      const denied = await executeLocalCommand(command, {
        workspace: { kind: "local", path: cwd },
        mode: "sandbox",
      });
      expect(denied.exitCode).not.toBe(0);
    },
  );

  test.skipIf(!hasBubblewrap)("Linux sandbox keeps a /tmp workspace writable", async () => {
    const cwd = mkdtempSync("/tmp/loopy-process-");
    const outside = mkdtempSync("/tmp/loopy-process-");
    workspaces.push(cwd, outside);
    const inside = await executeLocalCommand(
      {
        program: process.execPath,
        args: ["-e", "require('node:fs').writeFileSync('inside', process.env.LOOPY_TEST_VALUE)"],
        env: { LOOPY_TEST_VALUE: "ok" },
      },
      { workspace: { kind: "local", path: cwd }, mode: "sandbox" },
    );
    if (inside.exitCode !== 0) {
      throw new Error(
        `Linux sandbox exited ${inside.exitCode}: stdout=${JSON.stringify(inside.stdout)} stderr=${JSON.stringify(inside.stderr)}`,
      );
    }
    expect(readFileSync(join(cwd, "inside"), "utf8")).toBe("ok");

    const denied = await executeLocalCommand(
      {
        program: process.execPath,
        args: [
          "-e",
          "require('node:fs').writeFileSync(process.argv[1], 'no')",
          join(outside, "escape"),
        ],
      },
      { workspace: { kind: "local", path: cwd }, mode: "sandbox" },
    );
    expect(denied.exitCode).not.toBe(0);
    expect(existsSync(join(outside, "escape"))).toBe(false);

    const server = Bun.serve({ port: 0, fetch: () => new Response("reachable") });
    try {
      const network = {
        program: process.execPath,
        args: ["-e", `console.log(await (await fetch('http://127.0.0.1:${server.port}')).text())`],
      };
      expect(
        (
          await executeLocalCommand(network, {
            workspace: { kind: "local", path: cwd },
            mode: "full",
          })
        ).stdout,
      ).toContain("reachable");
      expect(
        (
          await executeLocalCommand(network, {
            workspace: { kind: "local", path: cwd },
            mode: "sandbox",
          })
        ).exitCode,
      ).not.toBe(0);
    } finally {
      server.stop(true);
    }
  });

  test.skipIf(!hasBubblewrap || !existsSync("/usr/bin/cc"))(
    "Linux sandbox does not load command libraries in the launcher",
    async () => {
      const cwd = workspace();
      const outside = workspace();
      const library = join(cwd, "preload.so");
      const source = join(cwd, "preload.c");
      const insideMarker = join(cwd, "inside-preload");
      const outsideMarker = join(outside, "outside-preload");
      writeFileSync(
        source,
        `#include <fcntl.h>
#include <unistd.h>
__attribute__((constructor)) static void mark(void) {
  int inside = open(${JSON.stringify(insideMarker)}, O_WRONLY | O_CREAT, 0600);
  if (inside >= 0) close(inside);
  int outside = open(${JSON.stringify(outsideMarker)}, O_WRONLY | O_CREAT, 0600);
  if (outside >= 0) close(outside);
}
`,
      );
      const compiled = spawnSync("/usr/bin/cc", ["-shared", "-fPIC", source, "-o", library], {
        encoding: "utf8",
      });
      if (compiled.status !== 0) throw new Error(`Could not compile preload: ${compiled.stderr}`);

      const output = await executeLocalCommand(
        { program: "/bin/echo", args: ["inside"], env: { LD_PRELOAD: library } },
        { workspace: { kind: "local", path: cwd }, mode: "sandbox" },
      );
      if (output.exitCode !== 0) throw new Error(`Sandbox failed: ${output.stderr}`);
      expect(output.stdout).toBe("inside\n");
      expect(existsSync(insideMarker)).toBe(true);
      expect(existsSync(outsideMarker)).toBe(false);
    },
  );
});
