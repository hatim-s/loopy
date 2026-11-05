import { expect, test } from "bun:test";
import { Deferred, Effect, Fiber } from "effect";
import { RuntimeLimit } from "../runtime-limit.js";

test("interrupted waiters never execute and an interrupted holder releases capacity", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const limit = new RuntimeLimit(1);
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();

      const holder = yield* Effect.forkChild(
        limit.run(
          Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
          }),
        ),
      );

      yield* Deferred.await(entered);
      let ran = false;

      const waiter = yield* Effect.forkChild(
        limit.run(
          Effect.sync(() => {
            ran = true;
          }),
        ),
      );

      yield* Effect.yieldNow;
      yield* Fiber.interrupt(waiter);
      yield* Fiber.interrupt(holder);
      expect(ran).toBe(false);
      expect(yield* limit.run(Effect.succeed("available"))).toBe("available");
    }),
  );
});

test("an already aborted external signal never dispatches queued work", async () => {
  const abort = new AbortController();
  abort.abort(new Error("fixture abort"));
  let ran = false;

  const result = await Effect.runPromise(
    Effect.exit(
      new RuntimeLimit(1).run(
        Effect.sync(() => {
          ran = true;
        }),
        abort.signal,
      ),
    ),
  );

  expect(result._tag).toBe("Failure");
  expect(ran).toBe(false);
});

test("external abort cancels queued admission while an admitted holder retains its permit", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const limit = new RuntimeLimit(1);
      const entered = yield* Deferred.make<void>();
      const done = yield* Deferred.make<void>();
      const holderAbort = new AbortController();

      const holder = yield* Effect.forkChild(
        limit.run(
          Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined);
            // This happens after acquisition; the queue must not interrupt this operation.
            holderAbort.abort();
            yield* Deferred.await(done);

            return "held";
          }),
          holderAbort.signal,
        ),
      );

      yield* Deferred.await(entered);
      const waiterAbort = new AbortController();
      let dispatched = false;

      const waiter = yield* Effect.forkChild(
        Effect.exit(
          limit.run(
            Effect.sync(() => {
              dispatched = true;
            }),
            waiterAbort.signal,
          ),
        ),
      );

      yield* Effect.yieldNow;
      waiterAbort.abort();
      const exit = yield* Fiber.join(waiter);
      expect(exit._tag).toBe("Failure");
      expect(dispatched).toBe(false);
      yield* Deferred.succeed(done, undefined);
      expect(yield* Fiber.join(holder)).toBe("held");
      expect(yield* limit.run(Effect.succeed("free"))).toBe("free");
    }),
  );
});
