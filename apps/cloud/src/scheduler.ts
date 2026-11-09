import type { DurableObjectStorage } from "@cloudflare/workers-types";
import { type DurableTurn, errorMessage } from "@loopy/core";
import {
  activateDurable,
  type DurableExecutionProvider,
  fireDueSchedules,
  SCHEDULE_POLICY,
  ScheduleDefinitionError,
} from "@loopy/runtime/host";
import { requireDefinition } from "@loopy/runtime/service";
import { leaseExpiresAt, type SqlRunStore } from "@loopy/runtime/store/portable";
import { Cause, Clock, Effect, Exit } from "effect";
import type { R2ArtifactRegistry } from "./artifacts";
import { cloudSync, platform } from "./operation";

export type SchedulerStorage = Pick<DurableObjectStorage, "getAlarm" | "setAlarm" | "deleteAlarm">;

/** Keeps the last whole-turn failure outside the runtime tables. */
export type SchedulerFailureLog = { read(): string | null; write(error: string): void };

export const SCHEDULER = {
  /** Retry deadline after a failed release or activation turn. */
  retryMs: 1000,
  /** Alarm armed before each turn so an evicted object resumes its persisted work. */
  recoveryMs: 5000,
  alarmFloorMs: 50,
  strandedBatch: 32,
  maxWork: 16,
  pollMs: 500,
  leaseMs: 10_000,
  statusErrors: 20,
} as const;

const iso = (ms: number) => new Date(ms).toISOString();

/** Runs an effect to its exit. Interrupts propagate; any other failure becomes a bounded message. */
function turnFailure<A, E>(effect: Effect.Effect<A, E>) {
  return Effect.gen(function* () {
    const exit = yield* Effect.exit(effect);

    if (Exit.isSuccess(exit)) {
      return { ok: true as const, value: exit.value };
    }

    if (Cause.hasInterrupts(exit.cause)) {
      return yield* Effect.failCause(exit.cause);
    }

    return {
      ok: false as const,
      error: errorMessage(Cause.squash(exit.cause)).slice(0, SCHEDULE_POLICY.errorChars),
    };
  });
}

export class WorkspaceScheduler {
  constructor(
    private readonly options: {
      storage: SchedulerStorage;
      failures: SchedulerFailureLog;
      store: SqlRunStore;
      registry: Pick<R2ArtifactRegistry, "get" | "revisionGraph">;
      provider: DurableExecutionProvider;
      token: string;
      concurrency: number;
    },
  ) {}

  wake() {
    return Effect.gen({ self: this }, function* () {
      const at = yield* Clock.currentTimeMillis;
      const current = yield* platform("get alarm", () => this.options.storage.getAlarm());

      if (current === null || at < current) {
        yield* platform("set alarm", () => this.options.storage.setAlarm(at));
      }
    });
  }

  status() {
    return Effect.gen({ self: this }, function* () {
      const { storage, store, failures } = this.options;

      return {
        alarm: yield* platform("get alarm", () => storage.getAlarm()),
        errors: yield* store.turnErrors(SCHEDULER.statusErrors),
        schedules: yield* store.scheduleFailures(SCHEDULER.statusErrors),
        schedulerError: yield* cloudSync("read scheduler error", () => failures.read()),
      };
    });
  }

  private foreignLease(turn: DurableTurn, now: number): string | null {
    const owner = turn.owner;

    if (owner === null || owner.token === this.options.token || owner.heartbeatAt === null) {
      return null;
    }

    const expires = leaseExpiresAt(owner.heartbeatAt, this.options.store.leaseMs);

    return now < expires ? iso(expires) : null;
  }

  private releaseStranded(now: number) {
    return Effect.gen({ self: this }, function* () {
      const { store } = this.options;

      for (const turn of yield* store.strandedTurns(iso(now), SCHEDULER.strandedBatch)) {
        const lease = this.foreignLease(turn, now);
        const owner = turn.owner;

        // Suspension already committed. Releasing it preserves waits without taking a slot.
        const released = yield* turnFailure(
          lease === null && owner !== null ? store.release(turn.runId, owner.token) : Effect.void,
        );

        yield* store.saveTurn({
          runId: turn.runId,
          nextAt: released.ok ? (lease ?? iso(now)) : iso(now + SCHEDULER.retryMs),
          cursor: null,
          error: released.ok ? null : released.error,
        });
      }
    });
  }

  private activate(turn: DurableTurn, now: number) {
    return Effect.gen({ self: this }, function* () {
      const { store, registry, provider, token } = this.options;
      const lease = this.foreignLease(turn, now);

      if (lease !== null) {
        return yield* store.saveTurn({
          runId: turn.runId,
          nextAt: lease,
          cursor: turn.cursor,
          error: null,
        });
      }

      const result = yield* turnFailure(
        Effect.gen(function* () {
          const run = yield* store.getRun(turn.runId);

          if (!run) {
            return null;
          }

          return yield* activateDurable({
            store,
            graph: yield* registry.revisionGraph(run.revision),
            runId: run.id,
            provider,
            token,
            at: iso(yield* Clock.currentTimeMillis),
            cursor: turn.cursor,
            maxWork: SCHEDULER.maxWork,
            pollMs: SCHEDULER.pollMs,
          });
        }),
      );

      if (!result.ok) {
        return yield* store.saveTurn({
          runId: turn.runId,
          nextAt: iso(now + SCHEDULER.retryMs),
          cursor: turn.cursor,
          error: result.error,
        });
      }

      // The run disappeared, so there is no turn to persist.
      if (result.value !== null) {
        yield* store.saveTurn({
          runId: turn.runId,
          nextAt: result.value.nextWakeAt ?? iso(now),
          cursor: result.value.cursor,
          error: null,
        });
      }
    });
  }

  private nextAlarm(now: number) {
    return Effect.gen({ self: this }, function* () {
      const { store, concurrency } = this.options;

      const dates = [yield* store.nextScheduleAt(), yield* store.nextTurnAt(concurrency)].flatMap(
        (at) => (at === undefined ? [] : [Date.parse(at)]),
      );

      return dates.length === 0 ? null : Math.max(now + SCHEDULER.alarmFloorMs, Math.min(...dates));
    });
  }

  tick() {
    return Effect.gen({ self: this }, function* () {
      const { storage, store, registry, concurrency } = this.options;
      const now = yield* Clock.currentTimeMillis;
      yield* platform("set recovery alarm", () => storage.setAlarm(now + SCHEDULER.recoveryMs));

      const turn = yield* turnFailure(
        Effect.gen({ self: this }, function* () {
          yield* fireDueSchedules(
            {
              store,
              definitionFor: (schedule) =>
                requireDefinition(registry, schedule.slug).pipe(
                  Effect.mapError((cause) => new ScheduleDefinitionError({ cause })),
                ),
            },
            iso(now),
          );
          yield* this.releaseStranded(now);

          for (const candidate of yield* store.dueTurns(iso(now), concurrency)) {
            yield* this.activate(candidate, now);
          }

          yield* store.pruneEvents(iso(now));
          const next = yield* this.nextAlarm(yield* Clock.currentTimeMillis);

          if (next === null) {
            yield* platform("delete alarm", () => storage.deleteAlarm());
          } else {
            yield* platform("set alarm", () => storage.setAlarm(next));
          }
        }),
      );

      // The recovery alarm armed before the turn stays in place.
      if (!turn.ok) {
        yield* cloudSync("record scheduler failure", () => this.options.failures.write(turn.error));
      }
    });
  }
}
