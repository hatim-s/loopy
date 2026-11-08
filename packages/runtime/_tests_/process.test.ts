import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { CommandExecutionError, spawnCaptured } from "../src/os";
import { canSandbox, run, workspace } from "./fixtures/local-command";
import { onCleanup } from "./fixtures/test-scope";
import { bounded, waitForExit, waitForFile } from "./fixtures/wait";

const pidIn = (cwd: string, name: string) => Number(readFileSync(join(cwd, name), "utf8"));

function spawn(
  cwd: string,
  [program, ...args]: [string, ...string[]],
  options: {
    stdin?: string;
    env?: Record<string, string>;
    timeoutMs?: number;
    maxOutputBytes?: number;
    signal?: AbortSignal;
  } = {},
) {
  return spawnCaptured(
    { program, args, cwd, env: { PATH: process.env.PATH, ...options.env }, stdin: options.stdin },
    {
      timeoutMs: options.timeoutMs ?? 30_000,
      maxOutputBytes: options.maxOutputBytes ?? 1024 * 1024,
      signal: options.signal,
    },
  );
}

describe("process executor", () => {
  test("passes arguments literally and preserves a failing exit code", async () => {
    const cwd = workspace();

    const output = await Effect.runPromise(
      spawn(cwd, ["/bin/echo", "$(touch injected)", "; exit 2"]),
    );

    expect(output.stdout).toBe("$(touch injected) ; exit 2\n");
    expect(existsSync(join(cwd, "injected"))).toBe(false);

    const failed = await Effect.runPromise(spawn(cwd, [process.execPath, "-e", "process.exit(7)"]));

    expect(failed.exitCode).toBe(7);
  });

  test.skipIf(!canSandbox)(
    "resolves relative PATH entries from the command directory",
    async () => {
      const cwd = workspace();
      mkdirSync(join(cwd, "tools"));
      const executable = join(cwd, "tools", "probe-cmd");
      writeFileSync(executable, "#!/bin/sh\necho expected\n");
      chmodSync(executable, 0o755);

      const output = await Effect.runPromise(
        run(
          { program: "probe-cmd", args: [], env: { PATH: "tools" } },
          { workspace: cwd, mode: "full" },
        ),
      );

      expect(output.stdout).toBe("expected\n");
    },
  );

  test("bounds combined output", async () => {
    const result = await Effect.runPromise(
      spawn(
        workspace(),
        [
          process.execPath,
          "-e",
          "process.stdout.write('a'.repeat(2048)); process.stderr.write('b'.repeat(2048))",
        ],
        { maxOutputBytes: 100 },
      ).pipe(Effect.flip),
    );

    expect(result).toBeInstanceOf(CommandExecutionError);
    expect(result.message).toContain("output exceeded 100 bytes");
    expect(Buffer.byteLength(result.output.stdout) + Buffer.byteLength(result.output.stderr)).toBe(
      100,
    );
  });

  test("passes stdin and explicit environment values", async () => {
    const output = await Effect.runPromise(
      spawn(
        workspace(),
        [
          process.execPath,
          "-e",
          "console.log(process.env.LOOPY_VALUE + ':' + await Bun.stdin.text())",
        ],
        { env: { LOOPY_VALUE: "input" }, stdin: "hello" },
      ),
    );

    expect(output.stdout).toBe("input:hello\n");
  });

  // Each descendant records its pid and outlives the test unless the spawn kills it.
  test("stops a timed out process and its descendants", async () => {
    const cwd = workspace();
    await expect(
      Effect.runPromise(
        spawn(cwd, ["/bin/sh", "-c", "sleep 30 & echo $! > child.pid; wait"], { timeoutMs: 1000 }),
      ),
    ).rejects.toThrow("timed out");
    await waitForExit(pidIn(cwd, "child.pid"));
  });

  test("stops background children after a successful parent exit", async () => {
    const cwd = workspace();

    const output = await Effect.runPromise(
      spawn(cwd, ["/bin/sh", "-c", "sleep 30 & echo $! > orphan.pid; exit 0"]),
    );

    expect(output.exitCode).toBe(0);
    await waitForExit(pidIn(cwd, "orphan.pid"));
  });

  test("settles when a separate session inherits output pipes", async () => {
    const cwd = workspace();

    const source = `
      const { spawn } = require("node:child_process");
      const child = spawn("/bin/sleep", ["60"], {
        detached: true,
        stdio: ["ignore", "inherit", "inherit"],
      });
      require("node:fs").writeFileSync("session.pid", String(child.pid));
      child.unref();
    `;

    const settled = Effect.runPromise(spawn(cwd, [process.execPath, "-e", source]));

    // The separate session keeps the pipes open for a minute, so waiting for them would hang.
    expect((await bounded(settled, "spawn settling", 10_000)).exitCode).toBe(0);
    const session = pidIn(cwd, "session.pid");
    onCleanup(() => {
      process.kill(session, "SIGKILL");
    });
  });

  test("kills descendants that ignore termination", async () => {
    const cwd = workspace();
    // An ignored signal stays ignored across exec, so the sleep itself ignores SIGTERM.
    const script = `sh -c 'trap "" TERM; echo $$ > ignored.pid; exec sleep 30' & wait`;

    await expect(
      Effect.runPromise(spawn(cwd, ["/bin/sh", "-c", script], { timeoutMs: 1000 })),
    ).rejects.toThrow("timed out");
    await waitForExit(pidIn(cwd, "ignored.pid"));
  });

  test("honors cancellation of a running command", async () => {
    const cwd = workspace();
    const controller = new AbortController();

    const running = Effect.runPromise(
      spawn(
        cwd,
        [process.execPath, "-e", 'await Bun.write("ready", ""); setTimeout(() => {}, 10000)'],
        { signal: controller.signal },
      ),
    );

    await waitForFile(join(cwd, "ready"));
    controller.abort();
    await expect(running).rejects.toThrow("aborted");
  });
});

test.skipIf(!canSandbox)(
  "fiber interruption waits for child death before removing scratch",
  async () => {
    const cwd = workspace();
    const controller = new AbortController();

    const pending = Effect.runPromise(
      run(
        {
          program: process.execPath,
          args: [
            "-e",
            'await Bun.write("ready.json", JSON.stringify({pid: process.pid, scratch: process.env.TMPDIR})); setInterval(() => {}, 1000);',
          ],
        },
        { workspace: cwd, mode: "sandbox" },
      ),
      { signal: controller.signal },
    );

    const rejected = pending.catch((error) => error);

    try {
      await waitForFile(join(cwd, "ready.json"));

      const ready = Schema.decodeUnknownSync(
        Schema.Struct({ pid: Schema.Number, scratch: Schema.String }),
      )(JSON.parse(readFileSync(join(cwd, "ready.json"), "utf8")));

      expect(existsSync(ready.scratch)).toBe(true);
      controller.abort();
      await rejected;
      expect(() => process.kill(ready.pid, 0)).toThrow();
      expect(existsSync(ready.scratch)).toBe(false);
    } finally {
      controller.abort();
      await rejected;
    }
  },
);

for (const reason of ["timeout", "output_limit", "rejected"] as const) {
  test(`process error tags distinguish ${reason} without inspecting messages`, async () => {
    const command =
      reason === "rejected"
        ? { program: "/missing-fixture-program", args: [] }
        : {
            program: process.execPath,
            args: [
              "-e",
              reason === "timeout"
                ? "setInterval(() => {}, 1000)"
                : 'process.stdout.write("x".repeat(10000))',
            ],
            timeoutMs: reason === "timeout" ? 50 : 5000,
            maxOutputBytes: 100,
          };

    const result = await Effect.runPromise(
      (reason === "rejected"
        ? run(command, { workspace: workspace(), mode: "full" })
        : spawn(workspace(), [command.program, ...command.args], command)
      ).pipe(Effect.result),
    );

    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "CommandExecutionError", reason },
    });
  });
}
