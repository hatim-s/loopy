import { expect, test } from "bun:test";
import type { Executor } from "@loopy/core";
import { activate } from "@loopy/runtime/host";
import { loopy, parallel, sh, wait } from "@loopy/sdk/graph";
import { Deferred, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { newRun } from "./fixture";
import { RetryGateStore } from "./host-policy-fixture";

test("admission commits work first and reloads a signal before reducing denial", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const now = Date.parse(newRun().createdAt);
      yield* TestClock.setTime(now);
      const denied = yield* Deferred.make<void>();

      const store = new RetryGateStore(denied);

      const graph = loopy("admission-race", {
        input: {},
        run: () =>
          parallel({
            work: () => sh(["true"], { rateLimit: { key: "shared", limit: 1, window: "1m" } }),
            approval: () => wait("approve", { payload: { kind: "value", type: "boolean" } }),
          }),
      }).graph;

      yield* store.createRun(newRun());
      yield* store.acquireRateLimit("shared", 1, 60_000, newRun().createdAt);
      const acquire = store.acquireRateLimit.bind(store);
      let signalled = false;
      store.acquireRateLimit = (...args) =>
        Effect.gen(function* () {
          if (!signalled) {
            signalled = true;
            const hook = (yield* store.getWaits("run"))[0];
            expect(yield* store.getNodeRuns("run")).toEqual(
              expect.arrayContaining([expect.objectContaining({ status: "running", attempt: 1 })]),
            );

            if (!hook) {
              throw new Error("Admission preceded wait commit.");
            }

            expect(
              yield* store.resolveWait({
                token: hook.token,
                payload: true,
                at: new Date(now).toISOString(),
              }),
            ).toMatchObject({ kind: "resolved" });
          }

          return yield* acquire(...args);
        });
      const attempts: number[] = [];

      const executor: Executor = {
        lookup: () => Effect.succeed({ kind: "none" }),
        execute: (...[, attempt]) =>
          Effect.sync(() => {
            attempts.push(attempt);

            return { kind: "succeeded", output: { stdout: "", stderr: "", exitCode: 0 }, logs: [] };
          }),
      };

      const running = yield* Effect.forkChild(activate({ store, graph, executor, runId: "run" }));
      yield* Deferred.await(denied);
      expect(yield* store.getNodeRuns("run")).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ status: "succeeded", output: true }),
          expect.objectContaining({ status: "rate_limited", attempt: 1 }),
        ]),
      );
      expect(attempts).toEqual([]);
      yield* TestClock.adjust(60_000);
      expect(yield* Fiber.join(running)).toMatchObject({
        status: "succeeded",
        output: { approval: true },
      });
      expect(attempts).toEqual([1]);
    }).pipe(Effect.provide(TestClock.layer())),
  );
});
