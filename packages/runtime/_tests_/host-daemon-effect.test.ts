import { expect, test } from "bun:test";
import { loopy } from "@loopy/sdk/graph";
import { Deferred, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { FakeExecutor, newRun } from "../../core/_tests_/fixtures/run";
import { makeDaemon } from "../src/host";
import { MemorySqlStore } from "./fixtures/stores";

const empty = loopy("empty", { input: {}, run: () => 42 });

test("daemon wakes for a newly committed run and shuts down owned work", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const polled = yield* Deferred.make<void>();
        const prepared = yield* Deferred.make<void>();
        const gate = yield* Deferred.make<void>();

        class RecordingStore extends MemorySqlStore {
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
              Effect.as({ executor: new FakeExecutor(), graph: empty }),
            ),
          definitionFor: () => Effect.succeed({ revision: "bundle", graph: empty }),
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
