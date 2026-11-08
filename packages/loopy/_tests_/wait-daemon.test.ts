import { expect, test } from "bun:test";
import { makeDaemon } from "@loopy/runtime/host";
import { loopy, wait } from "@loopy/sdk/graph";
import { type Cause, Effect, Fiber, Queue } from "effect";
import { TestClock } from "effect/testing";
import { FakeExecutor, newRun } from "./fixture";
import { waitUntil } from "./fixtures/service-runtime";
import { MemorySqlStore } from "./store-fixture";

test("daemon leaves an indefinite sleep when a durable approval signal wakes its run", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const now = Date.parse(newRun().createdAt);
        yield* TestClock.setTime(now);
        const store = new MemorySqlStore();

        const graph = loopy("prompt", {
          input: {},
          run: () => wait("approve", { payload: { kind: "value", type: "boolean" } }),
        }).graph;

        yield* store.createRun({ ...newRun(), input: {} });
        const errors: Cause.Cause<unknown>[] = [];
        const inbox = yield* Queue.unbounded<void>();
        yield* Effect.acquireRelease(
          Effect.sync(() =>
            store.subscribe((events) => {
              if (events.some((event) => event.entity === "run" && event.kind === "finished")) {
                Queue.offerUnsafe(inbox, undefined);
              }
            }),
          ),
          (unsubscribe) => Effect.sync(unsubscribe),
        );

        const daemon = yield* makeDaemon({
          store,
          concurrency: 1,
          revisionFor: () => Effect.succeed("bundle"),
          prepare: () => Effect.succeed({ graph, executor: new FakeExecutor() }),
          onError: (cause) => {
            errors.push(cause);
          },
        });

        const running = yield* Effect.forkChild(daemon.run);
        yield* waitUntil(
          Effect.map(store.getRun("run"), (run) => run?.status === "suspended" && !run.owner),
        );
        const hook = (yield* store.getWaits("run"))[0];

        if (!hook) {
          throw new Error("Missing wait.");
        }

        expect((yield* store.getRun("run"))?.status).toBe("suspended");
        yield* store.resolveWait({
          token: hook.token,
          payload: true,
          at: new Date(now).toISOString(),
        });
        yield* Queue.take(inbox);
        expect(yield* store.getRun("run")).toMatchObject({ status: "succeeded", output: true });
        expect(errors).toEqual([]);
        yield* daemon.stop;
        yield* Fiber.join(running);
      }),
    ).pipe(Effect.provide(TestClock.layer())),
  );
});
