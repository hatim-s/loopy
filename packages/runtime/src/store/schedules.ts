import type { Schedule, ScheduleFailure, Store } from "@loopy/core";
import type { SqlContext, SqlWrite } from "./context";
import { emit } from "./events";
import { StoreRejectedError } from "./operation";
import { rowToSchedule, type ScheduleRow } from "./rows";
import { insertRun } from "./runs";
import { utc } from "./timestamps";

type ScheduleKey = Pick<Schedule, "workspace" | "slug">;

// Failures recorded for an older version describe a schedule that has since been saved again.
const CURRENT_FAILURE = "f.workspace=s.workspace AND f.slug=s.slug AND f.version=s.version";

function readSchedule(ctx: SqlContext, { workspace, slug }: ScheduleKey) {
  return (
    ctx.db
      .query<ScheduleRow, [string, string]>("SELECT * FROM schedules WHERE workspace=? AND slug=?")
      .get(workspace, slug) ?? undefined
  );
}

function emitSchedule(write: SqlWrite, schedule: ScheduleKey, kind: "saved" | "fired"): void {
  const row = readSchedule(write, schedule);

  if (!row) {
    throw new Error("Schedule disappeared before commit. Restore storage.");
  }

  emit(write, { entity: "schedule", kind, runId: null, record: rowToSchedule(row) });
}

export function readSchedules(ctx: SqlContext): Schedule[] {
  return ctx.db
    .query<ScheduleRow, []>("SELECT * FROM schedules ORDER BY rowid")
    .all()
    .map(rowToSchedule);
}

export function readDueSchedules(ctx: SqlContext, now: string, limit: number): Schedule[] {
  return ctx.db
    .query<ScheduleRow, [string, string, number]>(
      `SELECT s.* FROM schedules s LEFT JOIN schedule_failures f ON ${CURRENT_FAILURE}
      WHERE s.enabled=1 AND s.next_fire_at<=? AND (f.retry_at IS NULL OR f.retry_at<=?)
      ORDER BY s.next_fire_at,s.workspace,s.slug LIMIT ?`,
    )
    .all(utc(now), utc(now), limit)
    .map(rowToSchedule);
}

export function readNextScheduleAt(ctx: SqlContext): string | undefined {
  return (
    ctx.db
      .query<{ at: string | null }, []>(
        `SELECT MIN(MAX(s.next_fire_at,COALESCE(f.retry_at,s.next_fire_at))) AS at
        FROM schedules s LEFT JOIN schedule_failures f ON ${CURRENT_FAILURE} WHERE s.enabled=1`,
      )
      .get()?.at ?? undefined
  );
}

export function readScheduleFailures(ctx: SqlContext, limit: number): ScheduleFailure[] {
  return ctx.db
    .query<ScheduleFailure, [number]>(
      `SELECT f.workspace,f.slug,f.error,f.retry_at AS retryAt FROM schedule_failures f
      JOIN schedules s ON ${CURRENT_FAILURE} ORDER BY f.workspace,f.slug LIMIT ?`,
    )
    .all(limit);
}

export function putSchedule(write: SqlWrite, schedule: Omit<Schedule, "version">): Schedule {
  const row = write.db
    .query<ScheduleRow, [string, string, string, string, string, number, string | null, string]>(
      `INSERT INTO schedules VALUES (?,?,?,?,?,?,?,?,1) ON CONFLICT(workspace,slug) DO UPDATE SET
    cron=excluded.cron,tz=excluded.tz,input_json=excluded.input_json,enabled=excluded.enabled,
    last_fire_key=excluded.last_fire_key,next_fire_at=excluded.next_fire_at,version=schedules.version+1 RETURNING *`,
    )
    .get(
      schedule.workspace,
      schedule.slug,
      schedule.cron,
      schedule.tz,
      JSON.stringify(schedule.input),
      Number(schedule.enabled),
      schedule.lastFireKey ?? null,
      utc(schedule.nextFireAt),
    );

  if (!row) {
    throw new Error("Schedule was not saved. Restore storage.");
  }

  emitSchedule(write, schedule, "saved");

  return rowToSchedule(row);
}

export function setScheduleEnabled(
  write: SqlWrite,
  { workspace, slug, enabled, nextFireAt }: Parameters<Store["setScheduleEnabled"]>[0],
): Schedule {
  const row = write.db
    .query<ScheduleRow, [number, string | null, string, string]>(
      `UPDATE schedules SET enabled=?,version=version+1,
    next_fire_at=COALESCE(?,next_fire_at) WHERE workspace=? AND slug=? RETURNING *`,
    )
    .get(Number(enabled), nextFireAt === undefined ? null : utc(nextFireAt), workspace, slug);

  if (!row) {
    throw new StoreRejectedError(
      `Schedule '${slug}' does not exist. Save the schedule before toggling it.`,
    );
  }

  emitSchedule(write, row, "saved");

  return rowToSchedule(row);
}

export function deleteSchedule(write: SqlWrite, key: ScheduleKey): void {
  const row = readSchedule(write, key);

  write.db
    .query("DELETE FROM schedule_failures WHERE workspace=? AND slug=?")
    .run(key.workspace, key.slug);

  if (
    write.db
      .query("DELETE FROM schedules WHERE workspace=? AND slug=?")
      .run(key.workspace, key.slug).changes &&
    row
  ) {
    emit(write, {
      entity: "schedule",
      kind: "deleted",
      runId: null,
      record: { workspace: row.workspace, slug: row.slug },
    });
  }
}

export function fireSchedule(
  write: SqlWrite,
  { schedule, next, run }: Parameters<Store["fireSchedule"]>[0],
): boolean {
  if (!readSchedule(write, schedule)) {
    throw new StoreRejectedError(
      `Schedule '${schedule.slug}' does not exist. Save the schedule before firing it.`,
    );
  }

  const slot = utc(schedule.nextFireAt);
  const fireKey = `${schedule.slug}@${slot}`;

  const updated = write.db
    .query(
      `UPDATE schedules SET last_fire_key=?,next_fire_at=? WHERE workspace=? AND slug=?
    AND version=? AND enabled=1 AND next_fire_at=? AND (last_fire_key IS NULL OR last_fire_key<>?)`,
    )
    .run(fireKey, utc(next), schedule.workspace, schedule.slug, schedule.version, slot, fireKey);

  if (!updated.changes) {
    return false;
  }

  write.db
    .query("DELETE FROM schedule_failures WHERE workspace=? AND slug=?")
    .run(schedule.workspace, schedule.slug);
  insertRun(write, run);
  emitSchedule(write, schedule, "fired");

  return true;
}

export function failSchedule(
  write: SqlWrite,
  { schedule, error, retryAt }: Parameters<Store["failSchedule"]>[0],
): boolean {
  const { workspace, slug } = schedule;
  let version = schedule.version;

  if (retryAt === null) {
    const disabled = write.db
      .query<{ version: number }, [string, string, number]>(
        `UPDATE schedules SET enabled=0,version=version+1
      WHERE workspace=? AND slug=? AND version=? AND enabled=1 RETURNING version`,
      )
      .get(workspace, slug, version);

    if (!disabled) {
      return false;
    }

    version = disabled.version;
  }

  const recorded = write.db
    .query(
      `INSERT INTO schedule_failures(workspace,slug,version,retry_at,error)
    SELECT workspace,slug,version,?,? FROM schedules WHERE workspace=? AND slug=? AND version=?
    ON CONFLICT(workspace,slug) DO UPDATE SET
    version=excluded.version,retry_at=excluded.retry_at,error=excluded.error`,
    )
    .run(retryAt === null ? null : utc(retryAt), error, workspace, slug, version);

  if (retryAt === null) {
    emitSchedule(write, schedule, "saved");
  }

  return recorded.changes > 0;
}

export function readScheduleOverview(ctx: SqlContext) {
  return {
    workspaces: ctx.db
      .query<{ workspace: string }, []>(
        "SELECT DISTINCT workspace FROM schedules ORDER BY workspace",
      )
      .all()
      .map((row) => row.workspace),
    active:
      ctx.db
        .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM schedules WHERE enabled=1")
        .get()?.count ?? 0,
    next: ctx.db
      .query<Pick<Schedule, "workspace" | "slug" | "cron" | "tz" | "nextFireAt">, []>(
        `SELECT workspace,slug,cron,tz,next_fire_at AS nextFireAt FROM schedules
           WHERE enabled=1 ORDER BY next_fire_at,workspace,slug LIMIT 10`,
      )
      .all(),
  };
}
