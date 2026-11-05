import { Cause, Effect, Exit } from "effect";
import { decodeBoundary, scheduleSchema } from "../../../packages/loopy/src/contract/index.js";
import {
  errorMessage,
  nextFire,
  parseCron,
  validateGraphInput,
} from "../../../packages/loopy/src/core/index.js";
import type { SqlRunStore } from "../../../packages/loopy/src/store/portable.js";
import type { R2ArtifactRegistry } from "./artifacts.js";
import { CloudError, cloudSync } from "./operation.js";
import type { SchedulerStorage } from "./scheduler.js";

export class WorkspaceSchedules {
  constructor(
    private readonly options: {
      storage: SchedulerStorage;
      store: SqlRunStore;
      registry: Pick<R2ArtifactRegistry, "get">;
      workspace: string;
    },
  ) {
    options.storage.sql.exec(`CREATE TABLE IF NOT EXISTS cloud_schedule_turns (
      workspace TEXT NOT NULL, slug TEXT NOT NULL, version INTEGER NOT NULL,
      next_at TEXT NOT NULL, error TEXT NOT NULL,
      PRIMARY KEY (workspace,slug),
      FOREIGN KEY (workspace,slug) REFERENCES schedules(workspace,slug) ON DELETE CASCADE
    )`);
  }

  tick(now: string) {
    return Effect.gen({ self: this }, function* () {
      const { store, registry, workspace, storage } = this.options;

      const rows = yield* cloudSync("read cloud SQL", () =>
        storage.sql
          .exec<{ slug: string; version: number; record: string }>(
            `SELECT s.slug,s.version,json_patch(json_object(
        'workspace',s.workspace,'slug',s.slug,'cron',s.cron,'tz',s.tz,'input',json(s.input_json),
        'enabled',json('true'),'version',s.version,'nextFireAt',s.next_fire_at),
        CASE WHEN s.last_fire_key IS NULL THEN '{}' ELSE json_object('lastFireKey',s.last_fire_key) END) AS record
        FROM schedules s LEFT JOIN cloud_schedule_turns t
        ON s.workspace=t.workspace AND s.slug=t.slug AND s.version=t.version
        WHERE s.enabled=1 AND s.next_fire_at<=? AND (t.next_at IS NULL OR t.next_at<=?)
        ORDER BY s.next_fire_at,s.slug LIMIT 32`,
            now,
            now,
          )
          .toArray(),
      );

      for (const row of rows) {
        const result = yield* Effect.exit(
          Effect.gen(function* () {
            const schedule = yield* cloudSync("decode schedule", () =>
              decodeBoundary(scheduleSchema)(JSON.parse(row.record)),
            );

            const saved = yield* registry.get(schedule.slug);

            if (saved === null) {
              return yield* Effect.fail(
                new CloudError({
                  operation: "read saved schedule",
                  cause: `No saved loopy '${schedule.slug}'. Save it again before retrying the schedule.`,
                }),
              );
            }

            const input = validateGraphInput(saved.graph, schedule.input);

            if (!input.ok) {
              yield* store.setScheduleEnabled({ workspace, slug: schedule.slug, enabled: false });
              yield* cloudSync("cloud SQL", () =>
                storage.sql.exec(
                  "INSERT OR REPLACE INTO meta(key,value) VALUES (?,?)",
                  `schedule_error:${schedule.slug}`,
                  `Schedule disabled because the saved input no longer matches the current graph: ${input.error}`.slice(
                    0,
                    1000,
                  ),
                ),
              );

              return;
            }

            // Coalesce missed ticks into one run, retaining the fire identity across retries.
            yield* store.fireSchedule({
              workspace,
              slug: schedule.slug,
              version: schedule.version,
              fireKey: `${schedule.slug}@${schedule.nextFireAt}`,
              nextFireAt: nextFire(
                parseCron(schedule.cron),
                new Date(now),
                schedule.tz,
              ).toISOString(),
              run: {
                id: crypto.randomUUID(),
                slug: schedule.slug,
                revision: saved.revision,
                workspace,
                input: input.value,
                status: "queued",
                createdAt: now,
                updatedAt: now,
              },
            });
            yield* cloudSync("cloud SQL", () =>
              storage.sql.exec(
                "DELETE FROM cloud_schedule_turns WHERE workspace=? AND slug=?",
                workspace,
                schedule.slug,
              ),
            );
            yield* cloudSync("cloud SQL", () =>
              storage.sql.exec("DELETE FROM meta WHERE key=?", `schedule_error:${schedule.slug}`),
            );
          }),
        );

        if (Exit.isFailure(result)) {
          if (Cause.hasInterrupts(result.cause)) {
            return yield* Effect.failCause(result.cause);
          }

          const cause = result.cause;
          // Excluding failures until this persisted deadline lets later schedules enter the batch.
          yield* cloudSync("cloud SQL", () =>
            storage.sql.exec(
              `INSERT INTO cloud_schedule_turns(workspace,slug,version,next_at,error) VALUES (?,?,?,?,?)
          ON CONFLICT(workspace,slug) DO UPDATE SET
          version=excluded.version,next_at=excluded.next_at,error=excluded.error`,
              workspace,
              row.slug,
              row.version,
              new Date(Date.now() + 5000).toISOString(),
              errorMessage(Cause.squash(cause)).slice(0, 1000),
            ),
          );
        }
      }
    });
  }
}
