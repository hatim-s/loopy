import { expect, test } from "bun:test";
import { Cause, Deferred, Effect, Exit, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { OwnershipError, StorageError } from "../src/core/index.js";
import { DriverCleanupFailed, withHeartbeat } from "../src/host/heartbeat.js";
import { MemoryStore } from "../src/store/index.js";
import { newRun } from "./fixture.js";

test("heartbeat renews ownership using Effect time", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const renewed = yield* Deferred.make<void>();

      class RecordingStore extends MemoryStore {
        override heartbeat(id: string, token: string) {
          return super
            .heartbeat(id, token)
            .pipe(Effect.tap(() => Deferred.succeed(renewed, undefined)));
        }
      }

      const store = new RecordingStore(undefined, 2000);
      yield* store.createRun(newRun());
      yield* store.claim("run", "owner");

      const fiber = yield* Effect.forkChild(
        withHeartbeat(store, "run", "owner", Deferred.await(renewed).pipe(Effect.as(42))),
      );

      yield* TestClock.adjust(500);
      expect(yield* Fiber.join(fiber)).toBe(42);
      yield* store.release("run", "owner");
      expect((yield* store.getRun("run"))?.owner).toBeUndefined();
    }).pipe(Effect.provide(TestClock.layer())),
  );
});

for (const recovery of ["recover", "expire"] as const) {
  test(`heartbeat storage outage ${recovery} respects the last renewed lease`, async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        let calls = 0;
        let stopped = false;

        class OutageStore extends MemoryStore {
          override heartbeat() {
            calls++;

            return recovery === "recover" && calls > 1
              ? Effect.succeed(true)
              : Effect.fail(
                  new StorageError({
                    operation: "heartbeat",
                    reason: "unavailable",
                    cause: "fixture",
                  }),
                );
          }
        }

        const store = new OutageStore(undefined, 1000);

        const fiber = yield* Effect.forkChild(
          withHeartbeat(
            store,
            "run",
            "owner",
            Effect.never.pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  stopped = true;
                }),
              ),
            ),
          ),
        );

        yield* TestClock.adjust(250);
        expect(calls).toBe(1);
        expect(stopped).toBe(false);
        yield* TestClock.adjust(750);
        expect(stopped).toBe(recovery === "expire");

        if (recovery === "expire") {
          const exit = yield* Fiber.await(fiber);
          expect(
            Exit.isFailure(exit) &&
              exit.cause.reasons.some(
                (reason) => Cause.isFailReason(reason) && reason.error instanceof StorageError,
              ),
          ).toBe(true);
        } else {
          yield* Fiber.interrupt(fiber);
        }
      }).pipe(Effect.provide(TestClock.layer())),
    );
  });
}

test("heartbeat stays alive until interrupted driver cleanup is joined", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const began = yield* Deferred.make<void>();
      const cleaning = yield* Deferred.make<void>();
      const releaseCleanup = yield* Deferred.make<void>();
      let calls = 0;

      class RecordingStore extends MemoryStore {
        override heartbeat() {
          return Effect.sync(() => {
            calls++;

            return true;
          });
        }
      }

      const store = new RecordingStore(undefined, 1000);

      const work = Deferred.succeed(began, undefined).pipe(
        Effect.andThen(Effect.never),
        Effect.ensuring(
          Deferred.succeed(cleaning, undefined).pipe(
            Effect.andThen(Deferred.await(releaseCleanup)),
          ),
        ),
      );

      const fiber = yield* Effect.forkChild(withHeartbeat(store, "run", "owner", work));
      yield* Deferred.await(began);
      const interrupting = yield* Effect.forkChild(Fiber.interrupt(fiber));
      yield* Deferred.await(cleaning);
      yield* TestClock.adjust(750);
      expect(calls).toBe(3);
      yield* Deferred.succeed(releaseCleanup, undefined);
      yield* Fiber.join(interrupting);
      const count = calls;
      yield* TestClock.adjust(1000);
      expect(calls).toBe(count);
    }).pipe(Effect.provide(TestClock.layer())),
  );
});

for (const mixed of ["interrupt", "defect"] as const) {
  test(`heartbeat retry never discards a mixed storage/${mixed} Cause`, async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const storage = new StorageError({
          operation: "heartbeat",
          reason: "unavailable",
          cause: "fixture",
        });

        const defect = new Error("heartbeat cleanup defect");

        const original = Cause.combine(
          Cause.fail(storage),
          mixed === "interrupt" ? Cause.interrupt(123) : Cause.die(defect),
        );

        let calls = 0;

        class BrokenStore extends MemoryStore {
          override heartbeat() {
            calls++;

            return Effect.failCause(original);
          }
        }

        const fiber = yield* Effect.forkChild(
          withHeartbeat(new BrokenStore(undefined, 1000), "run", "owner", Effect.never),
        );

        yield* TestClock.adjust(250);
        const exit = yield* Fiber.await(fiber);
        expect(calls).toBe(1);
        expect(Exit.isFailure(exit)).toBe(true);

        if (Exit.isFailure(exit)) {
          expect(
            exit.cause.reasons.some(
              (reason) => Cause.isFailReason(reason) && reason.error === storage,
            ),
          ).toBe(true);

          if (mixed === "interrupt") {
            expect(Cause.hasInterrupts(exit.cause)).toBe(true);
          } else {
            expect(
              exit.cause.reasons.some(
                (reason) => Cause.isDieReason(reason) && reason.defect === defect,
              ),
            ).toBe(true);
          }
        }
      }).pipe(Effect.provide(TestClock.layer())),
    );
  });
}

test("expired heartbeat retains every storage failure reason", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const first = new StorageError({
        operation: "heartbeat",
        reason: "unavailable",
        cause: "first",
      });

      const second = new StorageError({
        operation: "heartbeat",
        reason: "unavailable",
        cause: "second",
      });

      class BrokenStore extends MemoryStore {
        override heartbeat() {
          return Effect.failCause(Cause.combine(Cause.fail(first), Cause.fail(second)));
        }
      }

      const fiber = yield* Effect.forkChild(
        withHeartbeat(new BrokenStore(undefined, 1000), "run", "owner", Effect.never),
      );

      yield* TestClock.adjust(1000);
      const exit = yield* Fiber.await(fiber);
      expect(Exit.isFailure(exit)).toBe(true);

      if (Exit.isFailure(exit)) {
        expect(exit.cause.reasons.filter(Cause.isFailReason).map((reason) => reason.error)).toEqual(
          [first, second],
        );
      }
    }).pipe(Effect.provide(TestClock.layer())),
  );
});

for (const primary of ["loss", "interrupt"] as const) {
  test(`${primary} retains driver cleanup defect along with supervision interruption`, async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const began = yield* Deferred.make<void>();
        const defect = new Error("driver cleanup defect");

        class LosingStore extends MemoryStore {
          override heartbeat() {
            return Effect.succeed(false);
          }
        }

        const work = Deferred.succeed(began, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(Effect.die(defect)),
        );

        const fiber = yield* Effect.forkChild(
          withHeartbeat(new LosingStore(undefined, 1000), "run", "owner", work),
        );

        yield* Deferred.await(began);

        if (primary === "loss") {
          yield* TestClock.adjust(250);
        } else {
          yield* Fiber.interrupt(fiber);
        }

        const exit = yield* Fiber.await(fiber);
        expect(Exit.isFailure(exit)).toBe(true);

        if (Exit.isFailure(exit)) {
          const cleanup = exit.cause.reasons
            .filter(Cause.isFailReason)
            .map((reason) => reason.error)
            .find((error) => error instanceof DriverCleanupFailed);

          expect(cleanup).toBeInstanceOf(DriverCleanupFailed);

          if (!(cleanup instanceof DriverCleanupFailed)) {
            throw new Error("Missing driver cleanup diagnostic");
          }

          expect(
            Exit.isFailure(cleanup.driver) &&
              cleanup.driver.cause.reasons.some(
                (reason) => Cause.isDieReason(reason) && reason.defect === defect,
              ),
          ).toBe(true);
          expect(Exit.isFailure(cleanup.driver) && Cause.hasInterrupts(cleanup.driver.cause)).toBe(
            true,
          );

          if (primary === "loss") {
            expect(
              exit.cause.reasons.some(
                (reason) => Cause.isFailReason(reason) && reason.error instanceof OwnershipError,
              ),
            ).toBe(true);
          } else {
            expect(Cause.hasInterrupts(exit.cause)).toBe(true);
          }
        }
      }).pipe(Effect.provide(TestClock.layer())),
    );
  });
}
