import {
  type Executor,
  type ExecutorError,
  type Graph,
  type OwnershipError,
  type RunOutcome,
  type StorageError,
  type Store,
  withLease,
} from "@loopy/core";
import type { EngineEvent } from "@loopy/core/engine";
import { Clock, Effect } from "effect";
import { type DriverCleanupFailed, withHeartbeat } from "../heartbeat";
import { commitTurn, type TurnOptions } from "../turn";
import { type ActivationWorkCleanupFailed, makeActivationWork } from "./work";

export type ActivationOptions = { store: Store; executor: Executor; runId: string; graph: Graph };

export type ActivationResult = RunOutcome | { status: "suspended" };

export type ActivationError =
  | StorageError
  | OwnershipError
  | ExecutorError
  | DriverCleanupFailed
  | ActivationWorkCleanupFailed;

function drive(options: ActivationOptions, turn: TurnOptions) {
  return Effect.scoped(
    Effect.gen(function* () {
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
                const { disposition, work: next, deadline } = yield* commitTurn(turn, event);

                if (disposition.kind === "finished") {
                  return disposition.outcome;
                }

                if (disposition.kind === "suspended") {
                  return { status: "suspended" } as const;
                }

                yield* work.dispatch(next, deadline);
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
  const { store, runId, graph } = options;

  return withLease(store, runId, (token, run) =>
    withHeartbeat(
      store,
      runId,
      token,
      drive(options, { store, graph, runId, token, input: run.input }),
    ),
  );
}
