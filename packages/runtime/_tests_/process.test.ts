import { describe, expect, test } from "bun:test";
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
import { join } from "node:path";
import { DEFAULT_MAX_OUTPUT_BYTES } from "@loopy/core";
import { Effect, Schema } from "effect";
import { CommandExecutionError, type ResolvedCommand, spawnCaptured } from "../src/os";
import { executeLocalCommand, type LocalExecutionOptions } from "../src/os/process";
import { qualityTestRoot } from "./fixtures/quality-test-root";
import { onCleanup } from "./fixtures/test-scope";
import { bounded, waitForExit, waitForFile } from "./fixtures/wait";

// Sandboxed bun children read ancestor tsconfig.json files, so stay outside the checkout.
const workspace = () => qualityTestRoot("process", { outsideCheckout: true });

const pidIn = (cwd: string, name: string) => Number(readFileSync(join(cwd, name), "utf8"));

const hasBubblewrap =
  process.platform === "linux" && (existsSync("/usr/bin/bwrap") || existsSync("/bin/bwrap"));

const canSandbox = process.platform === "darwin" || hasBubblewrap;

type CommandFields = Pick<ResolvedCommand, "program" | "args"> & Partial<ResolvedCommand>;

/** Production always runs commands sandboxed with a protected home and declared secrets. */
function run(
  fields: CommandFields,
  options: Pick<LocalExecutionOptions, "workspace" | "mode"> & Partial<LocalExecutionOptions>,
) {
  return executeLocalCommand(
    {
      cwd: null,
      env: {},
      stdin: null,
      timeoutMs: 300_000,
      maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
      ...fields,
    },
    { protectedHome: workspace(), sensitiveEnv: {}, ...options },
  );
}

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

  test("honors cancellation", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    await expect(
      Effect.runPromise(
        spawn(workspace(), [process.execPath, "-e", "setTimeout(() => {}, 10000)"], {
          signal: controller.signal,
        }),
      ),
    ).rejects.toThrow("aborted");
  });

  test.skipIf(process.platform !== "darwin")(
    "sandbox confines writes and rejects escaped directories",
    async () => {
      const cwd = workspace();
      const outside = workspace();

      const direct = await Effect.runPromise(
        run(
          {
            program: process.execPath,
            args: [
              "-e",
              "require('node:fs').writeFileSync('inside', process.env.LOOPY_TEST_VALUE)",
            ],
            env: { LOOPY_TEST_VALUE: "ok" },
          },
          { workspace: cwd, mode: "sandbox" },
        ),
      );

      expect(direct.exitCode).toBe(0);
      expect(readFileSync(join(cwd, "inside"), "utf8")).toBe("ok");

      const denied = await Effect.runPromise(
        run(
          {
            program: process.execPath,
            args: [
              "-e",
              "require('node:fs').writeFileSync(process.argv[1], 'no')",
              join(outside, "escaped"),
            ],
          },
          { workspace: cwd, mode: "sandbox" },
        ),
      );

      expect(denied.exitCode).not.toBe(0);
      expect(existsSync(join(outside, "escaped"))).toBe(false);

      symlinkSync(join(outside, "linked-escape"), join(cwd, "file-link"));

      const linked = await Effect.runPromise(
        run(
          {
            program: process.execPath,
            args: ["-e", "require('node:fs').writeFileSync('file-link', 'no')"],
          },
          { workspace: cwd, mode: "sandbox" },
        ),
      );

      expect(linked.exitCode).not.toBe(0);
      expect(existsSync(join(outside, "linked-escape"))).toBe(false);

      symlinkSync(outside, join(cwd, "link"));
      await expect(
        Effect.runPromise(
          run(
            { program: "/bin/echo", args: ["hello"], cwd: "link" },
            { workspace: cwd, mode: "sandbox" },
          ),
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
          await Effect.runPromise(
            run(command, {
              workspace: cwd,
              mode: "full",
            }),
          )
        ).stdout,
      ).toContain("reachable");

      const denied = await Effect.runPromise(
        run(command, {
          workspace: cwd,
          mode: "sandbox",
        }),
      );

      expect(denied.exitCode).not.toBe(0);
    } finally {
      server.stop(true);
    }
  });

  test.skipIf(process.platform !== "darwin")(
    "sandbox denies reads from a protected fixture home",
    async () => {
      const cwd = workspace();
      const protectedHome = workspace();
      writeFileSync(join(protectedHome, "private"), "fixture");

      const command = {
        program: process.execPath,
        args: [
          "-e",
          "require('node:fs').readFileSync(process.argv[1]); console.log('read')",
          join(protectedHome, "private"),
        ],
      };

      expect(
        (
          await Effect.runPromise(
            run(command, {
              workspace: cwd,
              mode: "full",
            }),
          )
        ).stdout,
      ).toContain("read");

      const denied = await Effect.runPromise(
        run(command, {
          workspace: cwd,
          mode: "sandbox",
          protectedHome,
        }),
      );

      expect(denied.exitCode).not.toBe(0);
    },
  );

  test.skipIf(!hasBubblewrap)("Linux sandbox keeps a /tmp workspace writable", async () => {
    // A literal /tmp, because this case proves bubblewrap keeps a /tmp workspace writable.
    const cwd = mkdtempSync("/tmp/loopy-process-");
    const outside = mkdtempSync("/tmp/loopy-process-");

    onCleanup(() => {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    });

    const inside = await Effect.runPromise(
      run(
        {
          program: process.execPath,
          args: ["-e", "require('node:fs').writeFileSync('inside', process.env.LOOPY_TEST_VALUE)"],
          env: { LOOPY_TEST_VALUE: "ok" },
        },
        { workspace: cwd, mode: "sandbox" },
      ),
    );

    if (inside.exitCode !== 0) {
      throw new Error(
        `Linux sandbox exited ${inside.exitCode}: stdout=${JSON.stringify(inside.stdout)} stderr=${JSON.stringify(inside.stderr)}`,
      );
    }

    expect(readFileSync(join(cwd, "inside"), "utf8")).toBe("ok");

    const denied = await Effect.runPromise(
      run(
        {
          program: process.execPath,
          args: [
            "-e",
            "require('node:fs').writeFileSync(process.argv[1], 'no')",
            join(outside, "escape"),
          ],
        },
        { workspace: cwd, mode: "sandbox" },
      ),
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
          await Effect.runPromise(
            run(network, {
              workspace: cwd,
              mode: "full",
            }),
          )
        ).stdout,
      ).toContain("reachable");
      expect(
        (
          await Effect.runPromise(
            run(network, {
              workspace: cwd,
              mode: "sandbox",
            }),
          )
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

      if (compiled.status !== 0) {
        throw new Error(`Could not compile preload: ${compiled.stderr}`);
      }

      const output = await Effect.runPromise(
        run(
          { program: "/bin/echo", args: ["inside"], env: { LD_PRELOAD: library } },
          { workspace: cwd, mode: "sandbox" },
        ),
      );

      if (output.exitCode !== 0) {
        throw new Error(`Sandbox failed: ${output.stderr}`);
      }

      expect(output.stdout).toBe("inside\n");
      expect(existsSync(insideMarker)).toBe(true);
      expect(existsSync(outsideMarker)).toBe(false);
    },
  );
});

test.skipIf(process.platform !== "darwin" && !hasBubblewrap)(
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
