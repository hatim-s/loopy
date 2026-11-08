import { expect, test } from "bun:test";
import type { Executor } from "@loopy/core";
import { loopy, parallel, sh, sleep, wait } from "@loopy/sdk";
import { Deferred, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { newRun } from "../../core/_tests_/fixtures/run";
import { activate, makeDaemon } from "../src/host";
import { withBundles } from "./fixtures/compiled";
import {
  policyGraph,
  policyRetry,
  policySuccess,
  policyWork,
  RetryGateStore,
} from "./fixtures/host-policy";

for (const hold of ["retry", "rate-limit"] as const) {
  test(`concurrency one retains ${hold} beside a wait until its deadline`, async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const start = Date.parse(newRun().createdAt);
          yield* TestClock.setTime(start);
          const waiting = yield* Deferred.make<void>();

          const store = new RetryGateStore(waiting, { leaseMs: 1000 });

          const graph =
            hold === "retry"
              ? policyGraph()
              : loopy("limited", {
                  input: {},
                  run: () =>
                    parallel({
                      work: () =>
                        sh(["true"], { rateLimit: { key: "shared", limit: 1, window: "1m" } }),
                      approval: () =>
                        wait("approve", { payload: { kind: "value", type: "boolean" } }),
                    }),
                });

          const starts: string[] = [];

          const executor: Executor = {
            lookup: () => Effect.succeed({ kind: "none" }),
            execute: (key, attempt) =>
              Effect.sync(() => {
                starts.push(`${key.runId}/${attempt}`);

                return hold === "retry"
                  ? key.runId === "run" && attempt === 1
                    ? policyRetry
                    : policySuccess
                  : {
                      kind: "succeeded",
                      output: { stdout: "", stderr: "", exitCode: 0 },
                      logs: [],
                    };
              }),
          };

          yield* store.createRun(newRun());
          yield* store.createRun({ ...newRun(), id: "second" });

          if (hold === "rate-limit") {
            yield* store.acquireRateLimit("shared", 1, 60_000, newRun().createdAt);
          }

          const daemon = yield* makeDaemon({
            store,
            concurrency: 1,
            prepare: () => Effect.succeed({ graph, executor }),
            definitionFor: () => Effect.succeed({ revision: "bundle", graph }),
          });

          const loop = yield* Effect.forkChild(daemon.run);
          yield* Deferred.await(waiting);
          expect((yield* store.getRun("run"))?.owner).toBeDefined();
          expect((yield* store.getRun("second"))?.status).toBe("queued");
          yield* TestClock.adjust(250);
          expect((yield* store.getRun("run"))?.owner?.heartbeatAt).toBe(
            new Date(start + 250).toISOString(),
          );
          const stopping = yield* Effect.forkChild(daemon.stop);
          yield* Effect.yieldNow;
          const remainder = (hold === "retry" ? 1000 : 60_000) - 250;
          yield* TestClock.adjust(remainder);
          yield* Fiber.join(stopping);
          yield* Fiber.join(loop);
          expect((yield* store.getRun("run"))?.owner).toBeUndefined();
          expect(starts.every((start) => start.startsWith("run/"))).toBe(true);
        }),
      ).pipe(Effect.provide(TestClock.layer())),
    );
  });
}

test("retry beside sleep keeps activation until both persisted deadlines settle", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const base = Date.parse(newRun().createdAt);
      yield* TestClock.setTime(base);
      const waiting = yield* Deferred.make<void>();

      const store = new RetryGateStore(waiting);

      const graph = loopy("retry-sleep", {
        input: {},
        run: () => parallel({ work: policyWork, nap: () => sleep("2s") }),
      });

      withBundles(graph);

      const executor: Executor = {
        lookup: () => Effect.succeed({ kind: "none" }),
        execute: (...[, attempt]) => Effect.succeed(attempt === 1 ? policyRetry : policySuccess),
      };

      yield* store.createRun(newRun());
      const running = yield* Effect.forkChild(activate({ store, executor, graph, runId: "run" }));
      yield* Deferred.await(waiting);
      expect((yield* store.getRun("run"))?.owner).toBeDefined();
      yield* TestClock.adjust(1000);
      const result = yield* Fiber.join(running);
      expect(result).toEqual({ status: "suspended" });
      expect(yield* store.getRun("run")).toMatchObject({
        wakeAt: new Date(base + 2000).toISOString(),
      });
      yield* TestClock.adjust(1000);
      expect(yield* activate({ store, executor, graph, runId: "run" })).toMatchObject({
        status: "succeeded",
      });
    }).pipe(Effect.provide(TestClock.layer())),
  );
});
