import {
  errorMessage,
  OwnershipError,
  type RunOutcome,
  type RunRecord,
  type StorageError,
  type Store,
} from "@loopy/core";
import { Cause, Data, Effect, type Exit } from "effect";
import { type ActivationOptions, activate, LEASE_RELEASE_TIMEOUT_MS } from "./activation";

export class PreparationError extends Data.TaggedError("PreparationError")<{ cause: unknown }> {}

export class PreparationReleaseFailed extends Data.TaggedError("PreparationReleaseFailed")<{
  runId: string;
  preparation: PreparationError;
  primary: Exit.Exit<RunOutcome, StorageError | OwnershipError>;
  cause: StorageError | OwnershipError;
}> {}

export class PreparationReleaseUnknown extends Data.TaggedError("PreparationReleaseUnknown")<{
  runId: string;
  preparation: PreparationError;
  primary: Exit.Exit<RunOutcome, StorageError | OwnershipError>;
}> {}

type Options = {
  store: Store;
  prepare: (
    run: RunRecord,
  ) => Effect.Effect<Pick<ActivationOptions, "graph" | "executor">, PreparationError>;
  stopped: () => boolean;
  onError: (cause: Cause.Cause<unknown>, run: RunRecord) => void;
};

export function activateRun(options: Options, run: RunRecord) {
  const report = (cause: Cause.Cause<unknown>) => Effect.sync(() => options.onError(cause, run));

  return Effect.gen(function* () {
    if (options.stopped()) {
      return false;
    }

    const prepared = yield* options.prepare(run).pipe(
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          const reason = cause.reasons[0];

          if (cause.reasons.length !== 1 || !reason || !Cause.isFailReason(reason)) {
            return yield* Effect.failCause(cause);
          }

          const preparation = reason.error;

          return yield* Effect.suspend(() => {
            const token = crypto.randomUUID();

            const outcome: RunOutcome = {
              status: "failed",
              error: errorMessage(preparation.cause),
            };

            return Effect.acquireUseRelease(
              options.store.claim(run.id, token),
              () => options.store.finishRun(run.id, token, outcome).pipe(Effect.as(outcome)),
              (claimed, primary) =>
                options.store.release(run.id, token).pipe(
                  Effect.mapError(
                    (cause) =>
                      new PreparationReleaseFailed({
                        runId: claimed.id,
                        preparation,
                        primary,
                        cause,
                      }),
                  ),
                  Effect.interruptible,
                  Effect.timeoutOrElse({
                    duration: LEASE_RELEASE_TIMEOUT_MS,
                    orElse: () =>
                      Effect.fail(
                        new PreparationReleaseUnknown({ runId: claimed.id, preparation, primary }),
                      ),
                  }),
                ),
            );
          }).pipe(Effect.andThen(report(Cause.fail(preparation))), Effect.as(undefined));
        }),
      ),
    );

    if (!prepared) {
      return true;
    }

    yield* activate({ ...prepared, store: options.store, runId: run.id });

    return true;
  }).pipe(
    Effect.catchCause((cause) => {
      if (Cause.hasInterrupts(cause)) {
        return Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : report(cause).pipe(Effect.andThen(Effect.failCause(cause)));
      }

      const contention = cause.reasons.every(
        (reason) => Cause.isFailReason(reason) && reason.error instanceof OwnershipError,
      );

      return contention ? Effect.succeed(false) : report(cause).pipe(Effect.as(false));
    }),
  );
}
