import {
  errorMessage,
  OwnershipError,
  type RunOutcome,
  type RunRecord,
  type Store,
  withLease,
} from "@loopy/core";
import { Cause, Clock, Data, Effect } from "effect";
import { type ActivationOptions, activate } from "./activation";

export class PreparationError extends Data.TaggedError("PreparationError")<{ cause: unknown }> {}

export type Prepare = (
  run: RunRecord,
) => Effect.Effect<Pick<ActivationOptions, "graph" | "executor">, PreparationError>;

type Options = {
  store: Store;
  prepare: Prepare;
  stopped: () => boolean;
  report: (cause: Cause.Cause<unknown>, run: RunRecord) => Effect.Effect<void>;
};

// A run that cannot be prepared fails durably, so the daemon does not retry it forever.
function failPreparation(store: Store, run: RunRecord, preparation: PreparationError) {
  const outcome: RunOutcome = { status: "failed", error: errorMessage(preparation.cause) };

  return withLease(store, run.id, (token) =>
    Effect.flatMap(Clock.currentTimeMillis, (now) =>
      store.apply({
        runId: run.id,
        token,
        effects: [{ kind: "finish_run", outcome, at: new Date(now).toISOString() }],
      }),
    ),
  );
}

/** Returns whether the activation made progress. Claim contention between daemons is expected. */
export function activateRun(options: Options, run: RunRecord) {
  const report = (cause: Cause.Cause<unknown>) => options.report(cause, run);

  return Effect.gen(function* () {
    if (options.stopped()) {
      return false;
    }

    // Only a lone preparation failure is a business failure. Interruption and defects propagate.
    const prepared = yield* options.prepare(run).pipe(
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          const reason = cause.reasons[0];

          if (cause.reasons.length !== 1 || !reason || !Cause.isFailReason(reason)) {
            return yield* Effect.failCause(cause);
          }

          yield* failPreparation(options.store, run, reason.error).pipe(
            Effect.ensuring(report(Cause.fail(reason.error))),
          );
        }),
      ),
    );

    if (prepared) {
      yield* activate({ ...prepared, store: options.store, runId: run.id });
    }

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
