import type { DurableObjectStorage, SqlStorageCursor } from "@cloudflare/workers-types";
import { errorMessage } from "@loopy/core";
import { activateDurable, type DurableExecutionProvider } from "@loopy/runtime/host";
import type { SqlRunStore, SqlValue } from "@loopy/runtime/store/portable";
import { Cause, Effect, Exit } from "effect";
import type { R2ArtifactRegistry } from "./artifacts";
import { cloudSync, platform } from "./operation";
import { WorkspaceSchedules } from "./scheduler-schedules";

export type SchedulerStorage = Pick<
  DurableObjectStorage,
  "getAlarm" | "setAlarm" | "deleteAlarm"
> & {
  sql: {
    exec<Row extends Record<string, SqlValue>>(
      query: string,
      ...bindings: SqlValue[]
    ): Pick<SqlStorageCursor<Row>, "toArray" | "one">;
  };
};

type Candidate = {
  id: string;
  cursor: string | null;
  owner_token: string | null;
  heartbeat_at: string | null;
};

export class WorkspaceScheduler {
  private readonly schedules: WorkspaceSchedules;

  constructor(
    private readonly options: {
      storage: SchedulerStorage;
      store: SqlRunStore;
      registry: Pick<R2ArtifactRegistry, "get" | "revisionGraph">;
      provider: DurableExecutionProvider;
      token: string;
      concurrency: number;
      workspace: string;
    },
  ) {
    options.storage.sql.exec(`CREATE TABLE IF NOT EXISTS cloud_turns (
      run_id TEXT PRIMARY KEY REFERENCES runs(id), next_at TEXT NOT NULL, cursor TEXT, error TEXT
    )`);
    this.schedules = new WorkspaceSchedules(options);
  }

  wake(at = Date.now()) {
    return Effect.gen({ self: this }, function* () {
      const current = yield* platform("get alarm", () => this.options.storage.getAlarm());

      if (current === null || at < current) {
        yield* platform("set alarm", () => this.options.storage.setAlarm(at));
      }
    });
  }

  private foreignLease(candidate: Candidate): string | null {
    const { token, store } = this.options;

    if (candidate.owner_token !== token && candidate.heartbeat_at !== null) {
      const expires = Date.parse(candidate.heartbeat_at) + store.leaseMs + 1;

      if (Date.now() < expires) {
        return new Date(expires).toISOString();
      }
    }

    return null;
  }

  private releaseSuspended(now: string) {
    return Effect.gen({ self: this }, function* () {
      const { storage, store } = this.options;

      const rows = yield* cloudSync("read cloud SQL", () =>
        storage.sql
          .exec<Candidate>(
            `SELECT r.id,t.cursor,r.owner_token,r.heartbeat_at FROM runs r
      LEFT JOIN cloud_turns t ON r.id=t.run_id
      WHERE r.status='suspended' AND r.owner_token IS NOT NULL
      AND (t.next_at IS NULL OR t.next_at<=?)
      ORDER BY COALESCE(t.next_at,r.created_at),r.id LIMIT 32`,
            now,
          )
          .toArray(),
      );

      for (const row of rows) {
        let nextAt = this.foreignLease(row);
        let error: string | null = null;

        // Suspension already committed. Releasing it preserves waits without taking a slot.
        const released = yield* Effect.exit(
          nextAt === null && row.owner_token !== null
            ? store.release(row.id, row.owner_token)
            : Effect.void,
        );

        if (Exit.isFailure(released)) {
          if (Cause.hasInterrupts(released.cause)) {
            return yield* Effect.failCause(released.cause);
          }

          const cause = released.cause;
          nextAt = new Date(Date.now() + 1000).toISOString();
          error = errorMessage(Cause.squash(cause)).slice(0, 1000);
        }

        yield* cloudSync("cloud SQL", () => this.saveTurn(row, nextAt ?? now, null, error));
      }
    });
  }

  private saveTurn(
    candidate: Candidate,
    nextAt: string,
    cursor: string | null,
    error: string | null,
  ) {
    this.options.storage.sql.exec(
      `INSERT INTO cloud_turns(run_id,next_at,cursor,error) VALUES (?,?,?,?)
      ON CONFLICT(run_id) DO UPDATE SET next_at=excluded.next_at,cursor=excluded.cursor,error=excluded.error`,
      candidate.id,
      nextAt,
      cursor,
      error,
    );
  }

  private candidates(now: string): Candidate[] {
    const { storage, concurrency } = this.options;

    const running = storage.sql
      .exec<Candidate>(
        `SELECT r.id,t.cursor,r.owner_token,r.heartbeat_at
      FROM runs r LEFT JOIN cloud_turns t ON r.id=t.run_id WHERE r.status='running'
      AND (t.next_at IS NULL OR t.next_at<=?) ORDER BY r.created_at,r.id LIMIT ?`,
        now,
        concurrency,
      )
      .toArray();

    const count = storage.sql
      .exec<{ count: number }>("SELECT COUNT(*) AS count FROM runs WHERE status='running'")
      .one().count;

    const free = Math.max(0, concurrency - count);

    const ready = storage.sql
      .exec<Candidate>(
        `SELECT r.id,t.cursor,r.owner_token,r.heartbeat_at
      FROM runs r LEFT JOIN cloud_turns t ON r.id=t.run_id
      WHERE r.owner_token IS NULL AND (r.status='queued' OR (r.status='suspended' AND r.wake_at<=?))
      AND (t.error IS NULL OR t.next_at<=?)
      ORDER BY r.created_at,r.id LIMIT ?`,
        now,
        now,
        free,
      )
      .toArray();

    return [...running, ...ready];
  }

  private next(now: number): number | null {
    const { storage, concurrency } = this.options;

    const deadlines = storage.sql
      .exec<{ at: string | null }>(
        `SELECT MIN(MAX(s.next_fire_at,COALESCE(t.next_at,s.next_fire_at))) AS at
      FROM schedules s LEFT JOIN cloud_schedule_turns t
      ON s.workspace=t.workspace AND s.slug=t.slug AND s.version=t.version WHERE s.enabled=1
      UNION ALL SELECT MIN(COALESCE(t.next_at,r.heartbeat_at,r.created_at)) FROM runs r LEFT JOIN cloud_turns t ON r.id=t.run_id WHERE r.status='running'
      UNION ALL SELECT MIN(COALESCE(t.next_at,r.created_at)) FROM runs r LEFT JOIN cloud_turns t ON r.id=t.run_id
      WHERE r.status='suspended' AND r.owner_token IS NOT NULL
      UNION ALL SELECT MIN(MAX(CASE WHEN r.status='queued' THEN r.created_at ELSE r.wake_at END,
      CASE WHEN t.error IS NULL THEN r.created_at ELSE t.next_at END))
      FROM runs r LEFT JOIN cloud_turns t ON r.id=t.run_id
      WHERE r.owner_token IS NULL AND (r.status='queued' OR r.status='suspended')
      AND (SELECT COUNT(*) FROM runs WHERE status='running')<?`,
        concurrency,
      )
      .toArray();

    const dates = deadlines.flatMap(({ at }) => (at === null ? [] : [Date.parse(at)]));

    return dates.length === 0 ? null : Math.max(now + 50, Math.min(...dates));
  }

  tick() {
    return Effect.gen({ self: this }, function* () {
      const { storage, store, registry, provider, token } = this.options;
      const now = new Date().toISOString();
      yield* platform("set recovery alarm", () => storage.setAlarm(Date.now() + 5000));

      const turn = yield* Effect.exit(
        Effect.gen({ self: this }, function* () {
          yield* this.schedules.tick(now);
          yield* this.releaseSuspended(now);

          for (const candidate of yield* cloudSync("scheduler candidates", () =>
            this.candidates(now),
          )) {
            let nextAt = new Date(Date.now() + 1000).toISOString();
            let cursor = candidate.cursor;
            let error: string | null = null;
            const lease = this.foreignLease(candidate);

            if (lease === null) {
              const result = yield* Effect.exit(
                Effect.gen(function* () {
                  const run = yield* store.getRun(candidate.id);

                  if (!run) {
                    return null;
                  }

                  return yield* activateDurable({
                    store,
                    graph: yield* registry.revisionGraph(run.revision),
                    runId: run.id,
                    provider,
                    token,
                    at: new Date().toISOString(),
                    cursor,
                    maxWork: 16,
                    pollMs: 500,
                  });
                }),
              );

              if (Exit.isFailure(result)) {
                if (Cause.hasInterrupts(result.cause)) {
                  return yield* Effect.failCause(result.cause);
                }

                error = errorMessage(Cause.squash(result.cause)).slice(0, 1000);
              } else if (result.value === null) {
                continue;
              } else {
                cursor = result.value.cursor;
                nextAt = result.value.nextWakeAt ?? now;
              }
            } else {
              nextAt = lease;
            }

            yield* cloudSync("persist turn", () => this.saveTurn(candidate, nextAt, cursor, error));
          }

          yield* store.pruneEvents(now);
          const next = yield* cloudSync("next alarm", () => this.next(Date.now()));

          if (next === null) {
            yield* platform("delete alarm", () => storage.deleteAlarm());
          } else {
            yield* platform("set alarm", () => storage.setAlarm(next));
          }
        }),
      );

      if (Exit.isFailure(turn)) {
        if (Cause.hasInterrupts(turn.cause)) {
          return yield* Effect.failCause(turn.cause);
        }

        yield* cloudSync("record scheduler failure", () =>
          storage.sql.exec(
            "INSERT OR REPLACE INTO meta(key,value) VALUES ('cloud_scheduler_error',?)",
            errorMessage(Cause.squash(turn.cause)).slice(0, 1000),
          ),
        );
        yield* platform("set recovery alarm", () => storage.setAlarm(Date.now() + 5000));
      }
    });
  }
}
