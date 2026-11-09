import { expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { localDaemon } from "@loopy/runtime/local";
import { SecretStore } from "@loopy/runtime/os";
import { openRunStore } from "@loopy/runtime/store";
import { Effect } from "effect";
import { qualityTestRoot } from "../../runtime/_tests_/fixtures/quality-test-root";
import { onCleanup, runScoped } from "../../runtime/_tests_/fixtures/test-scope";
import { cli, spawnCli } from "./fixtures/cli";

const READER = resolve(import.meta.dir, "fixtures/secret-reader.ts");

// The terminal fixture requires python3 and its standard-library pty module on PATH.
for (const mode of ["pipe", "terminal"] as const) {
  test(`interrupting a ${mode} secret reader releases fixture stdin`, async () => {
    const root = qualityTestRoot("secret-interrupt");

    const argv =
      mode === "pipe"
        ? [process.execPath, "--no-env-file", READER, mode]
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
 result=subprocess.run([sys.argv[1],"--no-env-file",sys.argv[2],sys.argv[3]],stdin=slave,stderr=slave,stdout=subprocess.PIPE,timeout=10)
 sys.stdout.buffer.write(result.stdout)
 sys.exit(result.returncode)
finally:
 os.close(slave)
 os.close(master)`,
            process.execPath,
            READER,
            mode,
          ];

    const child = Bun.spawn(argv, {
      cwd: root,
      env: { PATH: process.env.PATH, HOME: root, TMPDIR: root, LOOPY_HOME: root },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    onCleanup(async () => {
      child.stdin.end();
      child.kill();
      await child.exited;
    });

    const stdout = await new Response(child.stdout).text();
    expect(await child.exited).toBe(0);
    const state = JSON.parse(stdout);
    expect(state.after).toBe(state.before);
    expect(state.paused).toBe(true);
    expect(state.rawAfter).toBe(state.rawBefore);
  });
}

test("oversized endless secret input releases stdin and exits with a typed failure", async () => {
  const root = qualityTestRoot("secret-overflow");
  const producer = Bun.spawn(["yes"], { cwd: root, stdout: "pipe", stderr: "ignore" });

  const child = spawnCli(
    { cwd: root, home: root },
    ["secrets", "set", "FOO_TOKEN", "--stdin"],
    producer.stdout,
  );

  onCleanup(async () => {
    child.kill();
    producer.kill();
    await Promise.all([child.exited, producer.exited]);
  });

  // A real deadline: the failure under test is the reader never stopping.
  const deadline = setTimeout(() => child.kill(), 5000);
  onCleanup(() => clearTimeout(deadline));
  const stderr = await new Response(child.stderr).text();
  expect(await child.exited).toBe(1);
  expect(stderr).toContain("Secret input exceeds 64 KiB.");
});

test("CLI stdin entry and name-only listing do not disclose values", async () => {
  const cwd = qualityTestRoot("secret-cli");
  const home = join(cwd, "home");
  const store = await runScoped(openRunStore(home));

  const daemon = await runScoped(
    localDaemon({ home, cwd, store, concurrency: 4, port: 0, assets: join(cwd, "assets") }),
  );

  await runScoped(daemon.start);
  const child = spawnCli({ cwd, home }, ["secrets", "set", "orbit-cookie", "--stdin"], "pipe");
  child.stdin.write("sensitive-marker\n");
  child.stdin.end();
  expect(await child.exited).toBe(0);
  expect(await new Response(child.stdout).text()).not.toContain("sensitive-marker");
  expect(await new Response(child.stderr).text()).not.toContain("sensitive-marker");
  expect(Effect.runSync(new SecretStore(home).values(["orbit-cookie"]))).toEqual({
    "orbit-cookie": "sensitive-marker",
  });

  const listed = await cli({ cwd, home }, "secrets", "list");
  expect(listed.code).toBe(0);
  expect(JSON.parse(listed.stdout)).toEqual(["orbit-cookie"]);
});
