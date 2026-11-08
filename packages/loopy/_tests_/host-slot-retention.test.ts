import { expect, test } from "bun:test";
import type { Executor } from "@loopy/core";
import { activate, makeDaemon } from "@loopy/runtime/host";
import { MemoryStore } from "@loopy/runtime/store";
import { loopy, parallel, sh, sleep, wait } from "@loopy/sdk/graph";
import { Deferred, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { newRun } from "./fixture";
import { policyGraph, policyRetry, policySuccess, policyWork } from "./host-policy-fixture";

for (const hold of ["retry", "rate-limit"] as const) {
  test(`concurrency one retains ${hold} beside a wait until its deadline`, async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          let now = Date.parse(newRun().createdAt);
          yield* TestClock.setTime(now);
          const waiting = yield* Deferred.make<void>();

          class RecordingStore extends MemoryStore {
            override apply(batch: Parameters<MemoryStore["apply"]>[0]) {
              return super
                .apply(batch)
                .pipe(
                  Effect.tap(() =>
                    batch.effects.some((effect) => effect.kind === "schedule_retry")
                      ? Deferred.succeed(waiting, undefined)
                      : Effect.void,
                  ),
                );
            }
          }

          const store = new RecordingStore(() => now, 1000);

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
            revisionFor: () => Effect.succeed("bundle"),
          });

          const tick = yield* Effect.forkChild(daemon.tick);
          yield* Deferred.await(waiting);
          expect((yield* store.getRun("run"))?.owner).toBeDefined();
          expect((yield* store.getRun("second"))?.status).toBe("queued");
          now += 250;
          yield* TestClock.adjust(250);
          expect((yield* store.getRun("run"))?.owner?.heartbeatAt).toBe(
            new Date(now).toISOString(),
          );
          const stopping = yield* Effect.forkChild(daemon.stop);
          yield* Effect.yieldNow;
          const remainder = (hold === "retry" ? 1000 : 60_000) - 250;
          now += remainder;
          yield* TestClock.adjust(remainder);
          yield* Fiber.join(stopping);
          yield* Fiber.join(tick);
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
      let now = base;
      const waiting = yield* Deferred.make<void>();

      class RecordingStore extends MemoryStore {
        override apply(batch: Parameters<MemoryStore["apply"]>[0]) {
          return super
            .apply(batch)
            .pipe(
              Effect.tap(() =>
                batch.effects.some((effect) => effect.kind === "schedule_retry")
                  ? Deferred.succeed(waiting, undefined)
                  : Effect.void,
              ),
            );
        }
      }

      const store = new RecordingStore(() => now);

      const graph = loopy("retry-sleep", {
        input: {},
        run: () => parallel({ work: policyWork, nap: () => sleep("2s") }),
      });

      for (const node of graph.nodes) {
        if (node.kind === "code") {
          node.module.bundleHash = "a".repeat(64);
        }
      }

      const executor: Executor = {
        lookup: () => Effect.succeed({ kind: "none" }),
        execute: (...[, attempt]) => Effect.succeed(attempt === 1 ? policyRetry : policySuccess),
      };

      yield* store.createRun(newRun());
      const running = yield* Effect.forkChild(activate({ store, executor, graph, runId: "run" }));
      yield* Deferred.await(waiting);
      expect((yield* store.getRun("run"))?.owner).toBeDefined();
      now += 1000;
      yield* TestClock.adjust(1000);
      const result = yield* Fiber.join(running);
      expect(result).toEqual({ status: "suspended" });
      expect((yield* store.getRun("run"))?.wakeAt).toBe(new Date(base + 2000).toISOString());
      now += 1000;
      yield* TestClock.adjust(1000);
      expect(yield* activate({ store, executor, graph, runId: "run" })).toMatchObject({
        status: "succeeded",
      });
    }).pipe(Effect.provide(TestClock.layer())),
  );
});
