import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { hasBubblewrap, run, workspace } from "./fixtures/local-command";
import { onCleanup } from "./fixtures/test-scope";

describe("sandbox profiles", () => {
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
