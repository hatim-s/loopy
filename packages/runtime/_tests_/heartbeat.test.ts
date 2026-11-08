import { expect, test } from "bun:test";
import { StorageError, type Store } from "@loopy/core";
import { Cause, Deferred, Effect, Exit, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { newRun } from "../../core/_tests_/fixtures/run";
import { withHeartbeat } from "../src/host/heartbeat";
import { MemorySqlStore } from "./fixtures/stores";

type HeartbeatStore = Pick<Store, "heartbeat" | "leaseMs">;

// Each renewal runs the heartbeat Effect again, so the fake decides its result when it runs.
function heartbeatStore(beat: () => ReturnType<Store["heartbeat"]>): HeartbeatStore {
  return { leaseMs: 1000, heartbeat: () => Effect.suspend(beat) };
}

test("heartbeat renews ownership using Effect time", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const renewed = yield* Deferred.make<void>();

      class RecordingStore extends MemorySqlStore {
        override heartbeat(id: string, token: string) {
          return super
            .heartbeat(id, token)
            .pipe(Effect.tap(() => Deferred.succeed(renewed, undefined)));
        }
      }

      const store = new RecordingStore({ leaseMs: 2000 });
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

        const store = heartbeatStore(() => {
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
        });

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

      const store = heartbeatStore(() => {
        calls++;

        return Effect.succeed(true);
      });

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

        const store = heartbeatStore(() => {
          calls++;

          return Effect.failCause(original);
        });

        const fiber = yield* Effect.forkChild(withHeartbeat(store, "run", "owner", Effect.never));

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

      const store = heartbeatStore(() =>
        Effect.failCause(Cause.combine(Cause.fail(first), Cause.fail(second))),
      );

      const fiber = yield* Effect.forkChild(withHeartbeat(store, "run", "owner", Effect.never));

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
