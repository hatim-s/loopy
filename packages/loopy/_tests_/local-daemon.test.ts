import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { processAlive } from "../src/executor/index.js";
import { daemonUrl, localDaemon, readDaemonFile } from "../src/local/index.js";
import { openRunStore } from "../src/store/index.js";

const roots: string[] = [];

function directory() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "loopy-local-daemon-")));
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

    url.searchParams.set("workspace", cwd);
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

test("ui starts a daemon on demand and exits with the caller workspace URL", async () => {
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
    const text = await new Response(child.stdout).text();
    expect(await child.exited).toBe(0);
    const record = readDaemonFile(home);

    if (!record) {
      throw new Error("Daemon discovery was not published.");
    }

    expect(record.pid).not.toBe(child.pid);
    const url = new URL(daemonUrl(record));
    url.searchParams.set("workspace", cwd);
    expect(text.trim()).toBe(url.toString());
  } finally {
    child.kill();
    await child.exited;
    const record = readDaemonFile(home);

    if (record) {
      process.kill(record.pid, "SIGTERM");

      for (let attempt = 0; attempt < 250 && processAlive(record.pid); attempt++) {
        await Bun.sleep(20);
      }

      if (processAlive(record.pid)) {
        throw new Error("Task daemon did not exit.");
      }
    }
  }
});

test("stop during startup waits for discovery publication and closes its listening server", async () => {
  const home = directory();
  const store = openRunStore(home);
  const daemon = localDaemon({ home, cwd: directory(), store, port: 0, concurrency: 1 });

  try {
    const lock = join(home, "daemon-start.lock");
    mkdirSync(lock);
    await expect(daemon.start()).rejects.toThrow("Another daemon startup holds");
    rmSync(lock, { recursive: true });
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
