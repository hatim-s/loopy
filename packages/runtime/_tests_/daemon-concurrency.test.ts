import { expect, test } from "bun:test";
import type { Executor } from "@loopy/core";
import { loopy, sh } from "@loopy/sdk/graph";
import { Deferred, Effect, Fiber } from "effect";
import { newRun } from "../../core/_tests_/fixtures/run";
import { makeDaemon } from "../src/host";
import { countPasses, nextPass, waitUntil } from "./fixtures/service-runtime";
import { MemorySqlStore } from "./fixtures/stores";

test("six runs respect concurrency two while the loop keeps polling", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const store = new MemorySqlStore();
        const passes = countPasses(store);
        const entered = yield* Deferred.make<void>();
        const gate = yield* Deferred.make<void>();
        const active = new Set<string>();
        const calls: string[] = [];
        let peak = 0;

        const executor: Executor = {
          lookup: () => Effect.succeed({ kind: "none" }),
          execute: (key) =>
            Effect.gen(function* () {
              active.add(key.runId);
              calls.push(key.runId);
              peak = Math.max(peak, active.size);

              if (active.size === 2) {
                yield* Deferred.succeed(entered, undefined);
              }

              yield* Deferred.await(gate);
              expect((yield* store.getRun(key.runId))?.owner).toBeDefined();
              active.delete(key.runId);

              return {
                kind: "succeeded" as const,
                output: { stdout: "done", stderr: "", exitCode: 0 },
                logs: [],
              };
            }).pipe(Effect.orDie),
        };

        const graph = loopy("test", { input: {}, run: () => sh(["printf", "done"]) });

        const daemon = yield* makeDaemon({
          store,
          concurrency: 2,
          prepare: () => Effect.succeed({ graph, executor }),
          definitionFor: () => Effect.succeed({ revision: "bundle", graph }),
        });

        for (let i = 0; i < 6; i++) {
          yield* store.createRun({ ...newRun(), id: String(i) });
        }

        yield* Effect.forkScoped(daemon.run);
        yield* Deferred.await(entered);
        // Full passes while both slots are held must not admit a third run.
        yield* nextPass(daemon, passes);
        expect(peak).toBe(2);
        yield* Deferred.succeed(gate, undefined);
        yield* waitUntil(
          Effect.map(
            store.queryRuns({ status: "succeeded", limit: 200, now: newRun().createdAt }),
            (runs) => runs.length === 6,
          ),
        );
        expect(peak).toBe(2);
        expect(new Set(calls).size).toBe(6);
        expect(calls).toHaveLength(6);
      }),
    ),
  );
});

test("shutdown drains owned work without aborting its receipt and preserves queued runs", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const store = new MemorySqlStore();
        const entered = yield* Deferred.make<void>();
        const gate = yield* Deferred.make<void>();
        let aborted = false;

        const executor: Executor = {
          lookup: () => Effect.succeed({ kind: "none" }),
          execute: (...[, , , signal]) =>
            Effect.gen(function* () {
              const abort = () => {
                aborted = true;
              };

              signal.addEventListener("abort", abort, { once: true });
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(gate);
              // Successful attempt scope closure aborts this signal after the worker has finished.
              signal.removeEventListener("abort", abort);

              return {
                kind: "succeeded" as const,
                output: { stdout: "done", stderr: "", exitCode: 0 },
                logs: [],
              };
            }),
        };

        const graph = loopy("test", { input: {}, run: () => sh(["printf", "done"]) });

        const daemon = yield* makeDaemon({
          store,
          concurrency: 1,
          prepare: () => Effect.succeed({ graph, executor }),
          definitionFor: () => Effect.succeed({ revision: "bundle", graph }),
        });

        yield* store.createRun(newRun());
        yield* store.createRun({ ...newRun(), id: "pending" });
        const running = yield* Effect.forkChild(daemon.run);
        yield* Deferred.await(entered);
        const stopping = yield* Effect.forkChild(daemon.stop);
        yield* Effect.yieldNow;
        expect(aborted).toBe(false);
        yield* Deferred.succeed(gate, undefined);
        yield* Fiber.join(stopping);
        yield* Fiber.join(running);
        expect(aborted).toBe(false);
        expect((yield* store.getRun("run"))?.owner).toBeUndefined();
        expect((yield* store.getRun("run"))?.status).toBe("succeeded");
        expect((yield* store.getRun("pending"))?.status).toBe("queued");
      }),
    ),
  );
});
