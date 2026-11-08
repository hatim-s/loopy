import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// The terminal fixture requires python3 and its standard-library pty module on PATH.
for (const mode of ["pipe", "terminal"] as const) {
  test(`interrupting a ${mode} secret reader releases fixture stdin`, async () => {
    const root = mkdtempSync(join(tmpdir(), "loopy-secret-interrupt-"));
    const script = join(root, "reader.ts");
    writeFileSync(
      script,
      `import {Effect,Fiber} from ${JSON.stringify(Bun.resolveSync("effect", import.meta.dir))};
import {readSecret} from ${JSON.stringify(resolve(import.meta.dir, "../src/secret-entry.ts"))};
await Effect.runPromise(Effect.gen(function* () {
  const before=process.stdin.listenerCount("data");
  const rawBefore=process.stdin.isRaw ?? false;
  const fiber=yield* Effect.forkChild(readSecret(${mode === "pipe"}));
  yield* Effect.yieldNow;
  yield* Fiber.interrupt(fiber);
  console.log(JSON.stringify({before,after:process.stdin.listenerCount("data"),paused:process.stdin.isPaused(),rawBefore,rawAfter:process.stdin.isRaw ?? false}));
}));`,
    );

    const argv =
      mode === "pipe"
        ? [process.execPath, "--no-env-file", script]
        : [
            "python3",
            "-c",
            `import os,pty,subprocess,sys,threading
master,slave=pty.openpty()
def drain():
 try:
  while os.read(master,4096): pass
 except OSError: pass
threading.Thread(target=drain,daemon=True).start()
try:
 result=subprocess.run([sys.argv[1],"--no-env-file",sys.argv[2]],stdin=slave,stderr=slave,stdout=subprocess.PIPE,timeout=10)
 sys.stdout.buffer.write(result.stdout)
 sys.exit(result.returncode)
finally:
 os.close(slave)
 os.close(master)`,
            process.execPath,
            script,
          ];

    const child = Bun.spawn(argv, {
      cwd: root,
      env: { PATH: process.env.PATH, HOME: root, TMPDIR: root, LOOPY_HOME: root },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    try {
      const stdout = await new Response(child.stdout).text();
      expect(await child.exited).toBe(0);
      const state = JSON.parse(stdout);
      expect(state.after).toBe(state.before);
      expect(state.paused).toBe(true);
      expect(state.rawAfter).toBe(state.rawBefore);
    } finally {
      child.stdin.end();
      child.kill();
      await child.exited;
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("oversized endless secret input releases stdin and exits with a typed failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "loopy-secret-overflow-"));
  const env = { PATH: process.env.PATH, HOME: root, TMPDIR: root, LOOPY_HOME: root };
  const producer = Bun.spawn(["yes"], { cwd: root, env, stdout: "pipe", stderr: "ignore" });

  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      resolve(import.meta.dir, "../src/index.ts"),
      "--home",
      root,
      "secrets",
      "set",
      "FOO_TOKEN",
      "--stdin",
    ],
    { cwd: root, env, stdin: producer.stdout, stdout: "pipe", stderr: "pipe" },
  );

  const deadline = setTimeout(() => child.kill(), 5000);

  try {
    const stderr = await new Response(child.stderr).text();
    expect(await child.exited).toBe(1);
    expect(stderr).toContain("Secret input exceeds 64 KiB.");
  } finally {
    clearTimeout(deadline);
    child.kill();
    producer.kill();
    await Promise.all([child.exited, producer.exited]);
    rmSync(root, { recursive: true, force: true });
  }
});
