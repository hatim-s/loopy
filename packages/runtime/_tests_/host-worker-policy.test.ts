import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ExecutionKey, OwnershipError, StorageError } from "@loopy/core";
import { code, loopy, sh } from "@loopy/sdk/graph";
import { Cause, Effect, Fiber } from "effect";
import { newRun } from "../../core/_tests_/fixtures/run";
import { LocalExecutor } from "../src/executor";
import { FilesystemReceipts } from "../src/executor/receipts";
import { activate, makeDaemon } from "../src/host";
import { MemorySqlStore } from "./fixtures/stores";

function waitForMarker(path: string) {
  return Effect.gen(function* () {
    for (let index = 0; index < 400; index++) {
      if (yield* Effect.promise(() => Bun.file(path).exists())) {
        return;
      }

      yield* Effect.sleep(10);
    }

    return yield* Effect.die(new Error("Isolated worker did not reach its marker."));
  });
}

for (const kind of ["command", "code"] as const) {
  for (const stop of ["ownership", "root"] as const) {
    test(`${stop} interruption preserves started ${kind} receipt and resumes as uncertain without replay`, async () => {
      const root = await mkdtemp(join(tmpdir(), "loopy-host-worker-"));
      const workspace = join(root, "workspace");
      const home = join(root, "home");
      await mkdir(join(workspace, ".loopy", "loopies"), { recursive: true });
      await mkdir(join(home, "bundles"), { recursive: true });
      const bundle = join(home, "bundles", "work.js");

      const script =
        'const f = Bun.file("started"); await Bun.write("started", (await f.exists() ? await f.text() : "") + "once\\n"); setInterval(() => {}, 1000);';

      await writeFile(bundle, script);
      let owned = true;

      class LosingStore extends MemorySqlStore {
        override heartbeat() {
          return Effect.sync(() => owned);
        }
      }

      const store = new LosingStore({ leaseMs: 400 });

      const executor = new LocalExecutor({
        home,
        workspace,
        mode: "sandbox",
        secrets: [],
        bundlePath: () => bundle,
      });

      const receipts = new FilesystemReceipts(home);

      const graph = loopy("worker-policy", {
        input: {},
        run: () =>
          kind === "command"
            ? sh([process.execPath, "--no-env-file", "-e", script])
            : code("work", { in: {}, out: { kind: "value", type: "number" }, module: "./work.ts" }),
      });

      for (const node of graph.nodes) {
        if (node.kind === "code") {
          node.module.bundleHash = "a".repeat(64);
        }
      }

      try {
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              yield* store.createRun({ ...newRun(), input: {} });

              const running = yield* Effect.forkChild(
                activate({ store, executor, graph, runId: "run" }),
              );

              yield* waitForMarker(join(workspace, "started"));

              const node = (yield* store.getNodeRuns("run")).find(
                (node) => node.status === "running",
              );

              if (!node) {
                throw new Error("Worker started before its node was persisted.");
              }

              const key: ExecutionKey = node.key;
              const before = yield* receipts.read({ executionKey: key, attempt: 1 });
              expect(before?.kind).toBe("started");

              if (stop === "ownership") {
                owned = false;
              } else {
                yield* Fiber.interrupt(running);
              }

              const exit = yield* Fiber.await(running);
              expect(
                exit._tag === "Failure" &&
                  (stop === "root"
                    ? Cause.hasInterrupts(exit.cause)
                    : exit.cause.reasons.some(
                        (reason) =>
                          Cause.isFailReason(reason) && reason.error instanceof OwnershipError,
                      )),
              ).toBe(true);
              const interrupted = yield* receipts.read({ executionKey: key, attempt: 1 });
              expect(interrupted?.kind).toBe("started");

              if (interrupted?.kind !== "started") {
                throw new Error("Interrupted receipt was replaced.");
              }

              expect(() => process.kill(interrupted.pid, 0)).toThrow();
              owned = true;
              const result = yield* activate({ store, executor, graph, runId: "run" });
              expect(result.status).toBe("failed");
              expect(yield* executor.lookup(key, 1)).toMatchObject({
                kind: "finished",
                result: { kind: "failed", error: { code: "uncertain" } },
              });
              expect(
                (yield* store.getNodeRuns("run")).find((node) => node.key.nodeId === key.nodeId),
              ).toMatchObject({ status: "failed", attempt: 1, error: { code: "uncertain" } });
              expect(
                yield* Effect.promise(() => readFile(join(workspace, "started"), "utf8")),
              ).toBe("once\n");
            }),
          ),
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }, 20_000);
  }
}

test("a completed real worker receipt wins after completion apply fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "loopy-host-finished-"));
  const workspace = join(root, "workspace");
  const home = join(root, "home");
  await mkdir(join(workspace, ".loopy", "loopies"), { recursive: true });
  await mkdir(home, { recursive: true });
  let reject = true;

  class UnavailableStore extends MemorySqlStore {
    override apply(batch: Parameters<MemorySqlStore["apply"]>[0]) {
      if (
        reject &&
        batch.effects.some(
          (effect) => effect.kind === "write_node_run" && effect.nodeRun.status === "succeeded",
        )
      ) {
        reject = false;

        return Effect.fail(
          new StorageError({
            operation: "apply",
            reason: "unavailable",
            cause: "fixture completion",
          }),
        );
      }

      return super.apply(batch);
    }
  }

  const store = new UnavailableStore();

  const executor = new LocalExecutor({
    home,
    workspace,
    mode: "sandbox",
    secrets: [],
    bundlePath: () => {
      throw new Error("Unexpected bundle");
    },
  });

  const graph = loopy("finished", {
    input: {},
    run: () =>
      sh([
        process.execPath,
        "--no-env-file",
        "-e",
        'const f = Bun.file("count"); const n = await f.exists() ? Number(await f.text()) : 0; await Bun.write("count", String(n+1)); console.log("ok");',
      ]),
  });

  try {
    await Effect.runPromise(store.createRun({ ...newRun(), input: {} }));
    const failed = await Effect.runPromiseExit(activate({ store, executor, graph, runId: "run" }));
    expect(failed._tag).toBe("Failure");
    expect((await Effect.runPromise(store.getRun("run")))?.status).toBe("suspended");
    expect(
      await Effect.runPromise(activate({ store, executor, graph, runId: "run" })),
    ).toMatchObject({ status: "succeeded" });
    expect(await readFile(join(workspace, "count"), "utf8")).toBe("1");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);

test("graceful daemon stop drains a real worker and retains its finished success", async () => {
  const root = await mkdtemp(join(tmpdir(), "loopy-host-drain-"));
  const workspace = join(root, "workspace");
  const home = join(root, "home");
  await mkdir(join(workspace, ".loopy", "loopies"), { recursive: true });
  await mkdir(home, { recursive: true });
  const store = new MemorySqlStore();

  const executor = new LocalExecutor({
    home,
    workspace,
    mode: "sandbox",
    secrets: [],
    bundlePath: () => {
      throw new Error("Unexpected bundle");
    },
  });

  const graph = loopy("drain", {
    input: {},
    run: () =>
      sh([
        process.execPath,
        "--no-env-file",
        "-e",
        'await Bun.write("started", "once"); while (!(await Bun.file("release").exists())) { await Bun.sleep(10); } console.log("ok");',
      ]),
  });

  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const daemon = yield* makeDaemon({
            store,
            concurrency: 1,
            prepare: () => Effect.succeed({ graph, executor }),
            definitionFor: () => Effect.succeed({ revision: "bundle", graph }),
          });

          yield* store.createRun({ ...newRun(), input: {} });
          const running = yield* Effect.forkChild(daemon.run);
          yield* waitForMarker(join(workspace, "started"));
          let stopped = false;

          const stopping = yield* Effect.forkChild(
            daemon.stop.pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  stopped = true;
                }),
              ),
            ),
          );

          yield* Effect.yieldNow;
          expect(stopped).toBe(false);
          yield* Effect.promise(() => writeFile(join(workspace, "release"), "release"));
          yield* Fiber.join(stopping);
          yield* Fiber.join(running);
          expect((yield* store.getRun("run"))?.status).toBe("succeeded");
          const node = (yield* store.getNodeRuns("run"))[0];

          if (!node) {
            throw new Error("Missing completed node");
          }

          expect(yield* executor.lookup(node.key, 1)).toMatchObject({
            kind: "finished",
            result: { kind: "succeeded" },
          });
          expect(node.attempt).toBe(1);
        }),
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);
