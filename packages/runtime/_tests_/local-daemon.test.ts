import { expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { localDaemon, readDaemonFile } from "../src/local";
import { removeDaemonFile, writeDaemonFile } from "../src/local/daemon/file";
import { openRunStore } from "../src/store";
import { qualityTestRoot } from "./fixtures/quality-test-root";

const directory = () => qualityTestRoot("local-daemon");

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
