import { OwnershipError, StorageError, type Store } from "@loopy/core";
import { Cause, Clock, Data, Deferred, Effect, Exit, Fiber } from "effect";

export class DriverCleanupFailed extends Data.TaggedError("DriverCleanupFailed")<{
  runId: string;
  primary: Exit.Exit<unknown, unknown>;
  driver: Exit.Exit<unknown, unknown>;
}> {}

/** Heartbeat outlives driver cleanup. A lost lease stops the driver, never restores ownership. */
export function withHeartbeat<A, E, R>(
  store: Store,
  runId: string,
  token: string,
  work: Effect.Effect<A, E, R>,
) {
  return Effect.scoped(
    Effect.gen(function* () {
      const lost = yield* Deferred.make<never, StorageError | OwnershipError>();
      let renewedAt = yield* Clock.currentTimeMillis;
      // Small fixture/provider leases need renewal below the old 250ms timer floor.
      const interval = Math.max(1, store.leaseMs / 4);

      const heartbeat = Effect.gen(function* () {
        while (true) {
          yield* Effect.sleep(interval);

          const owned = yield* store.heartbeat(runId, token).pipe(
            Effect.catchCause((cause) => {
              const recoverable =
                cause.reasons.length > 0 &&
                cause.reasons.every(
                  (reason) => Cause.isFailReason(reason) && reason.error instanceof StorageError,
                );

              if (!recoverable) {
                return Effect.failCause(cause);
              }

              return Clock.currentTimeMillis.pipe(
                Effect.flatMap((now) =>
                  now - renewedAt >= store.leaseMs
                    ? Effect.failCause(cause)
                    : Effect.succeed(undefined),
                ),
              );
            }),
          );

          if (owned === false) {
            return yield* Effect.fail(new OwnershipError(runId));
          }

          if (owned) {
            renewedAt = yield* Clock.currentTimeMillis;
          }
        }
      });

      yield* heartbeat.pipe(
        Effect.exit,
        Effect.flatMap((exit) => Deferred.done(lost, exit)),
        Effect.forkScoped,
      );
      let observedDriver = false;

      return yield* Effect.acquireUseRelease(
        Effect.forkScoped(Effect.interruptible(work)),
        (driver) =>
          Effect.gen(function* () {
            // Race observations only. The bracket owns interruption and captures the driver's final Exit.
            const winner = yield* Effect.raceFirst(
              Fiber.await(driver).pipe(Effect.map((exit) => ({ kind: "driver" as const, exit }))),
              Deferred.await(lost).pipe(
                Effect.exit,
                Effect.map((exit) => ({ kind: "loss" as const, exit })),
              ),
            );

            observedDriver = winner.kind === "driver";

            return yield* winner.exit;
          }),
        (driver, primary) =>
          Effect.gen(function* () {
            yield* Fiber.interrupt(driver);
            const stopped = yield* Fiber.await(driver);

            // Pure interruption is the requested stop. A mixed Cause contains cleanup failures we must retain.
            if (
              !observedDriver &&
              Exit.isFailure(stopped) &&
              !Cause.hasInterruptsOnly(stopped.cause)
            ) {
              // Effect promotes typed failures to defects when finalizer Causes contain defects.
              // Keep both exact Exits in a typed diagnostic instead of changing their reasons.
              return yield* Effect.fail(
                new DriverCleanupFailed({ runId, primary, driver: stopped }),
              );
            }
          }),
      );
    }),
  );
}
