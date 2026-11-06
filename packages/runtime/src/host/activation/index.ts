import type {
  Executor,
  ExecutorError,
  Graph,
  OwnershipError,
  RunOutcome,
  StorageError,
  Store,
} from "@loopy/core";
import { type EngineEvent, initialState, step } from "@loopy/core/engine";
import { Clock, Data, Effect, type Exit } from "effect";
import { type DriverCleanupFailed, withHeartbeat } from "../heartbeat";
import { planActivation } from "./plan";
import { type ActivationWorkCleanupFailed, makeActivationWork } from "./work";

export const LEASE_RELEASE_TIMEOUT_MS = 5000;

export type ActivationOptions = { store: Store; executor: Executor; runId: string; graph: Graph };

export type ActivationResult = RunOutcome | { status: "suspended" };

export type ActivationError =
  | StorageError
  | OwnershipError
  | ExecutorError
  | DriverCleanupFailed
  | ActivationWorkCleanupFailed;

export class LeaseReleaseUnknown extends Data.TaggedError("LeaseReleaseUnknown")<{
  runId: string;
  primary: Exit.Exit<ActivationResult, ActivationError>;
}> {}

export class LeaseReleaseFailed extends Data.TaggedError("LeaseReleaseFailed")<{
  runId: string;
  primary: Exit.Exit<ActivationResult, ActivationError>;
  cause: StorageError | OwnershipError;
}> {}

function drive(options: ActivationOptions, token: string) {
  return Effect.scoped(
    Effect.gen(function* () {
      const { store, graph, runId } = options;
      const run = yield* store.getRun(runId);

      if (!run) {
        return yield* Effect.die(new Error("Run disappeared before execution."));
      }

      let state = initialState(runId, run.input);

      let event: EngineEvent = {
        kind: "run_started",
        at: new Date(yield* Clock.currentTimeMillis).toISOString(),
      };

      const work = yield* makeActivationWork(options);

      return yield* Effect.acquireUseRelease(
        Effect.succeed(work),
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              while (true) {
                state = { ...state, nodeRuns: yield* store.getNodeRuns(runId) };
                const transition = step(graph, state, event);
                const plan = planActivation(transition);
                yield* store.apply({ runId, token, effects: plan.storeEffects });
                state = transition.state;

                if (plan.disposition.kind === "finished") {
                  return plan.disposition.outcome;
                }

                if (plan.disposition.kind === "suspended") {
                  return { status: "suspended" } as const;
                }

                yield* work.dispatch(plan.work);
                event = yield* work.next;
              }
            }),
          ),
        (owned, primary) => owned.checkCleanup(primary),
      );
    }),
  );
}

export function activate(options: ActivationOptions) {
  return Effect.suspend(() => {
    const token = crypto.randomUUID();

    return Effect.acquireUseRelease(
      options.store.claim(options.runId, token),
      () => withHeartbeat(options.store, options.runId, token, drive(options, token)),
      (lease, primary) =>
        options.store.release(options.runId, token).pipe(
          Effect.mapError((cause) => new LeaseReleaseFailed({ runId: lease.id, primary, cause })),
          Effect.interruptible,
          Effect.timeoutOrElse({
            duration: LEASE_RELEASE_TIMEOUT_MS,
            orElse: () => Effect.fail(new LeaseReleaseUnknown({ runId: lease.id, primary })),
          }),
        ),
    );
  });
}
