import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { daemonUrl, localDaemon, readDaemonFile } from "../src/local/index.js";
import { openRunStore } from "../src/store/index.js";

const roots: string[] = [];

function directory() {
  const root = mkdtempSync(join(tmpdir(), "loopy-local-daemon-"));
  roots.push(root);

  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

test("daemon publishes a private discovery file and removes it on clean shutdown", async () => {
  const home = directory();
  const cwd = directory();
  const store = openRunStore(home);
  const daemon = localDaemon({ home, cwd, store, port: 0, concurrency: 2 });

  try {
    const url = new URL(await daemon.start());
    expect(statSync(join(home, "daemon.json")).mode & 0o777).toBe(0o600);
    const record = readDaemonFile(home);
    expect(record).toMatchObject({
      pid: process.pid,
      port: Number(url.port),
      token: new URLSearchParams(url.hash.slice(1)).get("token"),
      startedAt: expect.any(String),
    });

    const child = Bun.spawn(
      [process.execPath, resolve(import.meta.dir, "../src/cli/index.ts"), "--home", home, "ui"],
      { cwd, stdout: "pipe", stderr: "pipe" },
    );

    expect((await new Response(child.stdout).text()).trim()).toBe(url.toString());
    expect(await child.exited).toBe(0);

    const status = Bun.spawn(
      [
        process.execPath,
        resolve(import.meta.dir, "../src/cli/index.ts"),
        "--home",
        home,
        "daemon",
        "status",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );

    expect(JSON.parse(await new Response(status.stdout).text())).toEqual(record);
    expect(await status.exited).toBe(0);
  } finally {
    await daemon.stop();
    store.close();
  }

  expect(existsSync(join(home, "daemon.json"))).toBe(false);
});

test("ui starts the foreground daemon when discovery is absent and removes it on SIGTERM", async () => {
  const home = directory();
  const cwd = directory();

  const child = Bun.spawn(
    [
      process.execPath,
      resolve(import.meta.dir, "../src/cli/index.ts"),
      "--home",
      home,
      "ui",
      "--port",
      "0",
    ],
    { cwd, stdout: "pipe", stderr: "pipe" },
  );

  try {
    for (let i = 0; i < 100 && !readDaemonFile(home); i++) {
      await Bun.sleep(20);
    }

    const record = readDaemonFile(home);
    expect(record?.pid).toBe(child.pid);
    const reader = child.stdout.getReader();
    const chunk = await reader.read();

    if (!record) {
      throw new Error("Daemon discovery was not published.");
    }

    expect(new TextDecoder().decode(chunk.value).trim()).toBe(daemonUrl(record));
    reader.releaseLock();
    child.kill("SIGTERM");
    expect(await child.exited).toBe(0);
    expect(existsSync(join(home, "daemon.json"))).toBe(false);
  } finally {
    child.kill();
    await child.exited;
  }
});

test("stop during startup waits for discovery publication and closes its listening server", async () => {
  const home = directory();
  const store = openRunStore(home);
  const daemon = localDaemon({ home, cwd: directory(), store, port: 0, concurrency: 1 });
  try {
    const starting = daemon.start();
    await daemon.stop();
    const url = new URL(await starting);
    expect(existsSync(join(home, "daemon.json"))).toBe(false);
    await expect(fetch(url.origin)).rejects.toThrow();
  } finally {
    await daemon.stop();
    store.close();
  }
});
