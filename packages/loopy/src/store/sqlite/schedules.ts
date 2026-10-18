import { type Schedule, type Store, StoreError } from "../../core/index.js";
import type { EventTransaction } from "../event-outbox.js";
import type { StoreContext } from "./context.js";
import { commit, emit } from "./events.js";
import { emitRun, getRow, insertRun } from "./runs.js";
import type { ScheduleRow } from "./store-schema.js";

const SQL = {
  schedules: "SELECT * FROM schedules ORDER BY rowid",
  schedule: "SELECT * FROM schedules WHERE workspace=? AND slug=?",
  putSchedule: `INSERT INTO schedules VALUES (?,?,?,?,?,?,?,?,1) ON CONFLICT(workspace,slug) DO UPDATE SET
    cron=excluded.cron,tz=excluded.tz,input_json=excluded.input_json,enabled=excluded.enabled,
    last_fire_key=excluded.last_fire_key,next_fire_at=excluded.next_fire_at,version=schedules.version+1 RETURNING *`,
  deleteSchedule: "DELETE FROM schedules WHERE workspace=? AND slug=?",
  setScheduleEnabled: `UPDATE schedules SET enabled=?,version=version+1,
    next_fire_at=COALESCE(?,next_fire_at) WHERE workspace=? AND slug=? RETURNING *`,
  advanceSchedule: `UPDATE schedules SET next_fire_at=? WHERE workspace=? AND slug=?
    AND version=? AND enabled=1`,
  fireSchedule: `UPDATE schedules SET last_fire_key=?,next_fire_at=? WHERE workspace=? AND slug=?
    AND version=? AND enabled=1 AND (last_fire_key IS NULL OR last_fire_key<>?)`,
};

export function rowToSchedule(row: ScheduleRow): Schedule {
  const schedule: Schedule = {
    version: row.version,
    workspace: row.workspace,
    slug: row.slug,
    cron: row.cron,
    tz: row.tz,
    input: JSON.parse(row.input_json),
    enabled: row.enabled === 1,
    nextFireAt: row.next_fire_at,
  };

  if (row.last_fire_key !== null) {
    schedule.lastFireKey = row.last_fire_key;
  }

  return schedule;
}

export async function putSchedule(
  context: StoreContext,
  schedule: Omit<Schedule, "version">,
): Promise<Schedule> {
  return commit(context, (txn) => {
    const row = context.db
      .query<ScheduleRow, [string, string, string, string, string, number, string | null, string]>(
        SQL.putSchedule,
      )
      .get(
        schedule.workspace,
        schedule.slug,
        schedule.cron,
        schedule.tz,
        JSON.stringify(schedule.input),
        Number(schedule.enabled),
        schedule.lastFireKey ?? null,
        schedule.nextFireAt,
      );

    if (!row) {
      throw new StoreError("write_failed");
    }

    emitSchedule(context, txn, schedule, "saved");

    return rowToSchedule(row);
  });
}

export async function setScheduleEnabled(
  context: StoreContext,
  { workspace, slug, enabled, nextFireAt }: Parameters<Store["setScheduleEnabled"]>[0],
): Promise<Schedule> {
  return commit(context, (txn) => {
    const row = context.db
      .query<ScheduleRow, [number, string | null, string, string]>(SQL.setScheduleEnabled)
      .get(Number(enabled), nextFireAt ?? null, workspace, slug);

    if (!row) {
      throw new StoreError("schedule_not_found");
    }

    emitSchedule(context, txn, row, "saved");

    return rowToSchedule(row);
  });
}

export async function advanceSchedule(
  context: StoreContext,
  options: Parameters<Store["advanceSchedule"]>[0],
): Promise<boolean> {
  return commit(context, (txn) => {
    const { workspace, slug, version, nextFireAt } = options;

    const updated = context.db.query(SQL.advanceSchedule).run(nextFireAt, workspace, slug, version);

    if (!updated.changes) {
      return false;
    }

    emitSchedule(context, txn, options, "saved");

    return true;
  });
}

export async function listSchedules(context: StoreContext): Promise<Schedule[]> {
  return context.db.query<ScheduleRow, []>(SQL.schedules).all().map(rowToSchedule);
}

export async function deleteSchedule(
  context: StoreContext,
  workspace: string,
  slug: string,
): Promise<void> {
  commit(context, (txn) => {
    const row = context.db.query<ScheduleRow, [string, string]>(SQL.schedule).get(workspace, slug);

    if (context.db.query(SQL.deleteSchedule).run(workspace, slug).changes && row) {
      const record = rowToSchedule(row);
      emit(context, txn, {
        entity: "schedule",
        kind: "deleted",
        runId: null,
        record: { workspace: record.workspace, slug: record.slug },
      });
    }
  });
}

export async function fireSchedule(
  context: StoreContext,
  options: Parameters<Store["fireSchedule"]>[0],
): Promise<boolean> {
  return commit(context, (txn) => {
    const { workspace, slug, version, fireKey, run, nextFireAt } = options;

    const schedule = context.db
      .query<ScheduleRow, [string, string]>(SQL.schedule)
      .get(workspace, slug);

    if (!schedule) {
      throw new StoreError("schedule_not_found");
    }

    const updated = context.db
      .query(SQL.fireSchedule)
      .run(fireKey, nextFireAt, workspace, slug, version, fireKey);

    if (!updated.changes) {
      return false;
    }

    if (getRow(context, run.id)) {
      throw new StoreError("already_exists");
    }

    insertRun(context, run);
    emitRun(context, txn, run.id, "created");
    emitSchedule(context, txn, schedule, "fired");

    return true;
  });
}

export function emitSchedule(
  context: StoreContext,
  txn: EventTransaction,
  schedule: Pick<Schedule, "workspace" | "slug">,
  kind: "saved" | "fired",
): void {
  const row = context.db
    .query<ScheduleRow, [string, string]>(SQL.schedule)
    .get(schedule.workspace, schedule.slug);

  if (!row) {
    throw new StoreError("write_failed");
  }

  emit(context, txn, { entity: "schedule", kind, runId: null, record: rowToSchedule(row) });
}
