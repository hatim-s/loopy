import { Cause, Clock, Data, Effect, Exit, Queue } from "effect";
import { executionKeyString } from "../../core";
import type { EngineEvent } from "../../engine";
import { completionEvent } from "../completion-event";
import { acquireDispatch } from "../rate-limit";
import type { ActivationOptions } from ".";
import type { ActivationWorkEffect } from "./plan";

const timestamp = Effect.map(Clock.currentTimeMillis, (now) => new Date(now).toISOString());

function execute(
  options: ActivationOptions,
  work: Extract<ActivationWorkEffect, { kind: "dispatch" }>,
) {
  return Effect.gen(function* () {
    while (true) {
      const receipt = yield* options.executor.lookup(work.executionKey, work.attempt);

      if (receipt.kind === "finished") {
        return receipt.result;
      }

      if (receipt.kind === "none") {
        // The signal bridge belongs to the Executor contract until that owner removes it.
        return yield* Effect.scoped(
          Effect.flatMap(Effect.abortSignal, (signal) =>
            options.executor.execute(work.executionKey, work.attempt, work.spec, signal),
          ),
        );
      }

      // Started receipts are never re-executed, including after observer interruption.
      yield* Effect.sleep(100);
    }
  });
}

function perform(options: ActivationOptions, work: ActivationWorkEffect) {
  return Effect.gen(function* () {
    if (work.kind === "dispatch") {
      const denial = yield* acquireDispatch({
        graph: options.graph,
        store: options.store,
        lookup: (key, attempt) => options.executor.lookup(key, attempt),
        dispatch: work,
        at: yield* timestamp,
      });

      if (denial) {
        return denial;
      }

      return completionEvent(work, yield* execute(options, work), yield* timestamp);
    }

    if (work.kind === "schedule_retry") {
      yield* Effect.sleep(Math.max(0, Date.parse(work.at) - (yield* Clock.currentTimeMillis)));

      return { kind: "retry_due", at: yield* timestamp } satisfies EngineEvent;
    }

    return {
      kind: "value_sampled",
      executionKey: work.executionKey,
      value: work.valueKind === "uuid" ? crypto.randomUUID() : Math.random(),
      at: yield* timestamp,
    } satisfies EngineEvent;
  });
}

type WorkError = Effect.Error<ReturnType<typeof perform>>;

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
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        options.store.subscribe((events) => {
          if (
            !wakeQueued &&
            events.some(
              (event) =>
                event.runId === options.runId &&
                event.entity === "hook" &&
                event.kind === "resolved",
            )
          ) {
            wakeQueued = true;
            Queue.offerUnsafe(inbox, { kind: "wake" });
          }
        }),
      ),
      (unsubscribe) => Effect.sync(unsubscribe),
    );

    const dispatch = (effects: ActivationWorkEffect[]) =>
      Effect.gen(function* () {
        for (const work of effects) {
          const id =
            work.kind === "schedule_retry"
              ? `retry/${work.at}`
              : `${executionKeyString(work.executionKey)}/${work.kind === "dispatch" ? work.attempt : "sample"}`;

          if (pending.has(id)) {
            continue;
          }

          pending.set(id, undefined);
          yield* perform(options, work).pipe(
            Effect.onExit((exit) =>
              Effect.sync(() => {
                pending.set(id, exit);
                Queue.offerUnsafe(inbox, { kind: "completion", id, exit });
              }),
            ),
            Effect.forkScoped,
          );
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
