import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { daemonUrl, localDaemon, readDaemonFile } from "@loopy/runtime/local";
import { openRunStore } from "@loopy/runtime/store";
import { Effect, Exit, Scope } from "effect";
import { removeDaemonFile, writeDaemonFile } from "../../runtime/src/local/daemon/file";

const roots: string[] = [];

function directory() {
  const root = mkdtempSync(join(tmpdir(), "loopy-local-daemon-"));
  roots.push(root);
  mkdirSync(join(root, ".loopy", "loopies"), { recursive: true });

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
  const scope = Effect.runSync(Scope.make());

  try {
    const store = await Effect.runPromise(
      openRunStore(home).pipe(Effect.provideService(Scope.Scope, scope)),
    );

    const daemon = await Effect.runPromise(
      localDaemon({ home, cwd, store, port: 0, concurrency: 2, assets: join(cwd, "assets") }).pipe(
        Effect.provideService(Scope.Scope, scope),
      ),
    );

    const url = new URL(await Effect.runPromise(daemon.start));
    expect(statSync(join(home, "daemon.json")).mode & 0o777).toBe(0o600);
    const record = readDaemonFile(home);
    expect(record).toMatchObject({
      pid: process.pid,
      port: Number(url.port),
      token: new URLSearchParams(url.hash.slice(1)).get("token"),
      startedAt: expect.any(String),
    });

    const child = Bun.spawn(
      [process.execPath, resolve(import.meta.dir, "../../cli/src/index.ts"), "--home", home, "ui"],
      {
        cwd,
        env: { PATH: process.env.PATH, HOME: cwd, TMPDIR: cwd, LOOPY_HOME: home },
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    expect((await new Response(child.stdout).text()).trim()).toBe(url.toString());
    expect(await child.exited).toBe(0);

    const status = Bun.spawn(
      [
        process.execPath,
        resolve(import.meta.dir, "../../cli/src/index.ts"),
        "--home",
        home,
        "daemon",
        "status",
      ],
      {
        cwd,
        env: { PATH: process.env.PATH, HOME: cwd, TMPDIR: cwd, LOOPY_HOME: home },
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    expect(JSON.parse(await new Response(status.stdout).text())).toEqual(record);
    expect(await status.exited).toBe(0);
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void));
  }

  expect(existsSync(join(home, "daemon.json"))).toBe(false);
});

test("ui starts the foreground daemon when discovery is absent and removes it on SIGTERM", async () => {
  const home = directory();
  const cwd = directory();

  const child = Bun.spawn(
    [
      process.execPath,
      resolve(import.meta.dir, "../../cli/src/index.ts"),
      "--home",
      home,
      "ui",
      "--port",
      "0",
    ],
    {
      cwd,
      env: { PATH: process.env.PATH, HOME: cwd, TMPDIR: cwd, LOOPY_HOME: home },
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  try {
    for (let i = 0; i < 100 && !readDaemonFile(home); i++) {
      await Bun.sleep(20);
    }

    const record = readDaemonFile(home);
    expect(record?.pid).toBe(child.pid);
    const reader = child.stdout.getReader();
    const chunk = await reader.read();
    expect(new TextDecoder().decode(chunk.value).trim()).toBe(daemonUrl(record!));
    reader.releaseLock();
    child.kill("SIGTERM");
    expect(await child.exited).toBe(0);
    expect(existsSync(join(home, "daemon.json"))).toBe(false);
  } finally {
    child.kill();
    await child.exited;
  }
});

test("second foreground daemon reports an actionable error", async () => {
  const home = directory();
  const cwd = directory();
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const store = yield* openRunStore(home);

        const daemon = yield* localDaemon({
          home,
          cwd,
          store,
          port: 0,
          concurrency: 1,
          assets: join(cwd, "assets"),
        });

        yield* daemon.start;

        const child = Bun.spawn(
          [
            process.execPath,
            resolve(import.meta.dir, "../../cli/src/index.ts"),
            "--home",
            home,
            "daemon",
            "run",
            "--port",
            "0",
          ],
          {
            cwd,
            env: { PATH: process.env.PATH, HOME: cwd, TMPDIR: cwd, LOOPY_HOME: home },
            stdout: "pipe",
            stderr: "pipe",
          },
        );

        const stderr = yield* Effect.promise(() => new Response(child.stderr).text());
        expect(yield* Effect.promise(() => child.exited)).toBe(1);
        expect(stderr).toContain("A daemon is already running for this home");
        expect(readDaemonFile(home)?.pid).toBe(process.pid);
      }),
    ),
  );
});

test("failed discovery publication closes its listener and permanently rejects restart", async () => {
  const home = directory();
  const cwd = directory();
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("probe") });
  const port = probe.port ?? 0;
  await probe.stop(true);
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const store = yield* openRunStore(home);

        const daemon = yield* localDaemon({
          home,
          cwd,
          store,
          port,
          concurrency: 1,
          // Insert a real publication fault after discovery reads and before listener creation.
          get assets() {
            mkdirSync(join(home, "daemon.json"));

            return join(cwd, "missing-assets");
          },
        });

        const first = yield* Effect.flip(daemon.start);
        expect(first.message).toContain("Cannot start daemon");
        rmSync(join(home, "daemon.json"), { recursive: true });
        const second = yield* Effect.flip(daemon.start);
        expect(second.message).toContain("This daemon has stopped");
        expect(readDaemonFile(home)).toBeUndefined();

        const rebound = Bun.serve({
          hostname: "127.0.0.1",
          port,
          fetch: () => new Response("rebound"),
        });

        yield* Effect.promise(() => rebound.stop(true));
      }),
    ),
  );
});

test("an already published daemon starts again without touching a contested startup lock", async () => {
  const home = directory();
  const cwd = directory();
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const store = yield* openRunStore(home);

        const daemon = yield* localDaemon({
          home,
          cwd,
          store,
          port: 0,
          concurrency: 1,
          assets: join(cwd, "assets"),
        });

        const url = yield* daemon.start;
        const lock = join(home, "daemon-start.lock");
        mkdirSync(lock);

        try {
          expect(yield* daemon.start).toBe(url);
          const record = readDaemonFile(home);
          expect(record).toBeDefined();

          const response = yield* Effect.promise(() =>
            fetch(`http://127.0.0.1:${record?.port}/api/daemon`, {
              headers: { Authorization: `Bearer ${record?.token}` },
            }),
          );

          expect(response.status).toBe(200);
        } finally {
          rmSync(lock, { recursive: true });
        }
      }),
    ),
  );
});

test("discovery cleanup never removes another daemon token", () => {
  const home = directory();
  writeDaemonFile(home, {
    pid: process.pid,
    port: 4310,
    token: "fixture-token",
    startedAt: new Date().toISOString(),
  });
  removeDaemonFile(home, "different-token");
  expect(readDaemonFile(home)?.token).toBe("fixture-token");
  removeDaemonFile(home, "fixture-token");
  expect(readDaemonFile(home)).toBeUndefined();
});

test("ui refuses an explicit port that differs from the running daemon", async () => {
  const home = directory();
  writeDaemonFile(home, {
    pid: process.pid,
    port: 4999,
    token: "fixture-token",
    startedAt: new Date().toISOString(),
  });

  const child = Bun.spawn(
    [
      process.execPath,
      resolve(import.meta.dir, "../../cli/src/index.ts"),
      "--home",
      home,
      "ui",
      "--port",
      "5000",
    ],
    {
      cwd: home,
      env: { PATH: process.env.PATH, HOME: home, TMPDIR: home, LOOPY_HOME: home },
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  expect(await new Response(child.stderr).text()).toContain(
    "A daemon is already running on port 4999.",
  );
  expect(await child.exited).toBe(1);
});
