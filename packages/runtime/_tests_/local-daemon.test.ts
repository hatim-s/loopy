import { expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { localDaemon, readDaemonFile } from "../src/local";
import { removeDaemonFile, writeDaemonFile } from "../src/local/daemon/file";
import { openRunStore } from "../src/store";
import { qualityTestRoot } from "./fixtures/quality-test-root";

const directory = () => qualityTestRoot("local-daemon");

const daemonIn = (home: string, cwd: string, port = 0) =>
  Effect.gen(function* () {
    const store = yield* openRunStore(home);

    return yield* localDaemon({
      home,
      cwd,
      store,
      port,
      concurrency: 1,
      assets: join(cwd, "assets"),
    });
  });

test("failed discovery publication closes its listener and permanently rejects restart", async () => {
  const home = directory();
  const cwd = directory();
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("probe") });
  const port = probe.port ?? 0;
  await probe.stop(true);
  // A directory where discovery belongs fails publication after the listener binds.
  mkdirSync(join(home, "daemon.json"), { recursive: true });
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const daemon = yield* daemonIn(home, cwd, port);
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
        // The failed start released the home, so another daemon can take it.
        const next = yield* daemonIn(home, cwd);
        yield* next.start;
      }),
    ),
  );
});

test("one daemon owns a home until it stops, and starting it again returns its address", async () => {
  const home = directory();
  const cwd = directory();
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const daemon = yield* daemonIn(home, cwd);
        const url = yield* daemon.start;
        expect(yield* daemon.start).toBe(url);
        const record = readDaemonFile(home);

        const response = yield* Effect.promise(() =>
          fetch(`http://127.0.0.1:${record?.port}/api/daemon`, {
            headers: { Authorization: `Bearer ${record?.token}` },
          }),
        );

        expect(response.status).toBe(200);
        const rival = yield* daemonIn(home, cwd);
        expect((yield* Effect.flip(rival.start)).message).toContain(
          "A daemon is already running for this home",
        );
        yield* daemon.stop;
        expect(readDaemonFile(home)).toBeUndefined();
        const successor = yield* daemonIn(home, cwd);
        expect(yield* successor.start).not.toBe(url);
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
