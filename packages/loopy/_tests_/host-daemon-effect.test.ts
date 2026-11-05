import { expect, test } from "bun:test";
import { Deferred, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { makeDaemon } from "../src/host/index.js";
import { loopy } from "../src/sdk/graph/index.js";
import { MemoryStore } from "../src/store/index.js";
import { FakeExecutor, newRun } from "./fixture.js";

test("daemon wakes for a newly committed run and shuts down owned work", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const polled = yield* Deferred.make<void>();
        const prepared = yield* Deferred.make<void>();
        const gate = yield* Deferred.make<void>();

        class RecordingStore extends MemoryStore {
          override dueRuns(at: string) {
            return super.dueRuns(at).pipe(Effect.tap(() => Deferred.succeed(polled, undefined)));
          }
        }

        const store = new RecordingStore();

        const daemon = yield* makeDaemon({
          store,
          concurrency: 2,
          prepare: () =>
            Deferred.succeed(prepared, undefined).pipe(
              Effect.andThen(Deferred.await(gate)),
              Effect.as({
                executor: new FakeExecutor(),
                graph: loopy("empty", { input: {}, run: () => 42 }).graph,
              }),
            ),
          revisionFor: () => Effect.succeed("bundle"),
        });

        const fiber = yield* Effect.forkChild(daemon.run);
        yield* Deferred.await(polled);
        yield* store.createRun(newRun());
        yield* Deferred.await(prepared);
        const stopping = yield* Effect.forkChild(daemon.stop);
        yield* Deferred.succeed(gate, undefined);
        yield* Fiber.join(stopping);
        yield* Fiber.join(fiber);
        expect((yield* store.getRun("run"))?.status).toBe("succeeded");
      }),
    ).pipe(Effect.provide(TestClock.layer())),
  );
});

test("tick admits concurrent runs within its limit", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const store = new MemoryStore();
        const both = yield* Deferred.make<void>();
        const gate = yield* Deferred.make<void>();
        let count = 0;

        const daemon = yield* makeDaemon({
          store,
          concurrency: 2,
          prepare: () =>
            Effect.gen(function* () {
              count++;

              if (count === 2) {
                yield* Deferred.succeed(both, undefined);
              }

              yield* Deferred.await(gate);

              return {
                executor: new FakeExecutor(),
                graph: loopy("empty", { input: {}, run: () => 42 }).graph,
              };
            }),
          revisionFor: () => Effect.succeed("bundle"),
        });

        yield* store.createRun(newRun());
        yield* store.createRun({ ...newRun(), id: "second" });
        const tick = yield* Effect.forkChild(daemon.tick);
        yield* Deferred.await(both);
        expect(count).toBe(2);
        yield* Deferred.succeed(gate, undefined);
        expect(yield* Fiber.join(tick)).toEqual({ fired: 0, activated: 2 });
      }),
    ),
  );
});
