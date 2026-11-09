import type { RunRecord, Schedule, Store } from "@loopy/core";
import { StoreRejectedError } from "../operation";
import { utc } from "../timestamps";
import type { SqlContext, SqlWrite } from "./context";
import { emit } from "./events";
import { rowToSchedule, type ScheduleRow } from "./rows";
import { insertRun } from "./runs";

type ScheduleKey = Pick<Schedule, "workspace" | "slug">;

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

export function readNextScheduleAt(ctx: SqlContext): string | undefined {
  return (
    ctx.db
      .query<{ at: string | null }, []>(
        "SELECT MIN(next_fire_at) AS at FROM schedules WHERE enabled=1",
      )
      .get()?.at ?? undefined
  );
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

export function advanceSchedule(
  write: SqlWrite,
  options: Parameters<Store["advanceSchedule"]>[0],
): boolean {
  const { workspace, slug, version, nextFireAt } = options;

  const updated = write.db
    .query(
      "UPDATE schedules SET next_fire_at=? WHERE workspace=? AND slug=? AND version=? AND enabled=1",
    )
    .run(utc(nextFireAt), workspace, slug, version);

  if (!updated.changes) {
    return false;
  }

  emitSchedule(write, options, "saved");

  return true;
}

export function deleteSchedule(write: SqlWrite, key: ScheduleKey): void {
  const row = readSchedule(write, key);

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
  options: ScheduleKey &
    Pick<Schedule, "version" | "nextFireAt"> & {
      fireKey: string;
      run: RunRecord;
    },
): boolean {
  const { workspace, slug, version, fireKey, run, nextFireAt } = options;
  const schedule = readSchedule(write, options);

  if (!schedule) {
    throw new StoreRejectedError(
      `Schedule '${slug}' does not exist. Save the schedule before firing it.`,
    );
  }

  const updated = write.db
    .query(
      `UPDATE schedules SET last_fire_key=?,next_fire_at=? WHERE workspace=? AND slug=?
    AND version=? AND enabled=1 AND (last_fire_key IS NULL OR last_fire_key<>?)`,
    )
    .run(fireKey, utc(nextFireAt), workspace, slug, version, fireKey);

  if (!updated.changes) {
    return false;
  }

  insertRun(write, run);
  emitSchedule(write, schedule, "fired");

  return true;
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
