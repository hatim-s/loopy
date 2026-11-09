import type { EngineEvent } from "@loopy/core/engine";
import { Cause, Clock, Data, Effect, Exit, Queue } from "effect";
import { subscribeStore } from "../subscription";
import {
  admitDispatch,
  completionEvent,
  type Dispatch,
  type HostWork,
  sampleEvent,
  workId,
} from "../turn";
import type { ActivationOptions } from ".";

const timestamp = Effect.map(Clock.currentTimeMillis, (now) => new Date(now).toISOString());

function dispatchResult(options: ActivationOptions, work: Dispatch) {
  return Effect.gen(function* () {
    const receipt = yield* options.executor.lookup(work.executionKey, work.attempt);

    if (receipt.kind === "finished") {
      return completionEvent(work, receipt.result, yield* timestamp);
    }

    // A started attempt was admitted before. Execute waits for it instead of running it again.
    if (receipt.kind === "none") {
      const denial = yield* admitDispatch({ ...options, dispatch: work, at: yield* timestamp });

      if (denial) {
        return denial;
      }
    }

    const result = yield* Effect.scoped(
      Effect.flatMap(Effect.abortSignal, (signal) =>
        options.executor.execute(work.executionKey, work.attempt, work.spec, signal),
      ),
    );

    return completionEvent(work, result, yield* timestamp);
  });
}

function perform(options: ActivationOptions, work: HostWork) {
  return work.kind === "dispatch"
    ? dispatchResult(options, work)
    : Effect.map(timestamp, (at) => sampleEvent(work, at));
}

function retryWhenDue(at: string) {
  return Effect.gen(function* () {
    yield* Effect.sleep(Math.max(0, Date.parse(at) - (yield* Clock.currentTimeMillis)));

    return { kind: "retry_due", at: yield* timestamp } satisfies EngineEvent;
  });
}

type WorkError = Effect.Error<ReturnType<typeof dispatchResult>>;

export class ActivationWorkCleanupFailed extends Data.TaggedError("ActivationWorkCleanupFailed")<{
  runId: string;
  primary: Exit.Exit<unknown, unknown>;
  attempts: readonly Exit.Exit<EngineEvent, WorkError>[];
}> {}

type Message =
  | { kind: "completion"; id: string; exit: Exit.Exit<EngineEvent, WorkError> }
  | { kind: "wake" };

export const makeActivationWork = (options: ActivationOptions) =>
  Effect.gen(function* () {
    const inbox = yield* Queue.unbounded<Message>();
    const pending = new Map<string, Exit.Exit<EngineEvent, WorkError> | undefined>();
    let wakeQueued = false;

    yield* subscribeStore(options.store, (events) => {
      if (
        !wakeQueued &&
        events.some(
          (event) =>
            event.runId === options.runId && event.entity === "hook" && event.kind === "resolved",
        )
      ) {
        wakeQueued = true;
        Queue.offerUnsafe(inbox, { kind: "wake" });
      }
    });

    const start = (id: string, effect: Effect.Effect<EngineEvent, WorkError>) =>
      Effect.gen(function* () {
        if (pending.has(id)) {
          return;
        }

        pending.set(id, undefined);
        yield* effect.pipe(
          Effect.onExit((exit) =>
            Effect.sync(() => {
              pending.set(id, exit);
              Queue.offerUnsafe(inbox, { kind: "completion", id, exit });
            }),
          ),
          Effect.forkScoped,
        );
      });

    const dispatch = (effects: HostWork[], deadline: string | null) =>
      Effect.gen(function* () {
        for (const work of effects) {
          yield* start(workId(work), perform(options, work));
        }

        if (deadline !== null) {
          yield* start(`retry/${deadline}`, retryWhenDue(deadline));
        }
      });

    const next = Effect.gen(function* () {
      if (pending.size === 0 && !wakeQueued) {
        return yield* Effect.die(new Error("Active run has no pending execution."));
      }

      const message = yield* Queue.take(inbox);

      if (message.kind === "wake") {
        wakeQueued = false;

        return { kind: "retry_due", at: yield* timestamp } satisfies EngineEvent;
      }

      pending.delete(message.id);

      return yield* message.exit;
    });

    const checkCleanup = (primary: Exit.Exit<unknown, unknown>) =>
      Effect.suspend(() => {
        const failures = [...pending.values()].flatMap((exit) =>
          exit !== undefined && Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)
            ? [exit]
            : [],
        );

        return failures.length === 0
          ? Effect.void
          : Effect.fail(
              new ActivationWorkCleanupFailed({
                runId: options.runId,
                primary,
                attempts: failures,
              }),
            );
      });

    return { dispatch, next, checkCleanup };
  });
