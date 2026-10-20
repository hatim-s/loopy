import type { Schedule } from "../../core/index.js";
import { type Store } from "../../core/index.js";
import { type EventTransaction } from "../event-outbox.js";
import { rowToSchedule, SQL } from "./store-rows.js";
import { type ScheduleRow } from "./store-schema.js";
import { SqliteWaits } from "./waits.js";

export class SqliteSchedules extends SqliteWaits {
  async putSchedule(schedule: Omit<Schedule, "version">): Promise<Schedule> {
    return this.commit((txn) => {
      const row = this.db
        .query<
          ScheduleRow,
          [string, string, string, string, string, number, string | null, string]
        >(SQL.putSchedule)
        .get(
          schedule.workspace,
          schedule.slug,
          schedule.cron,
          schedule.tz,
          JSON.stringify(schedule.input),
          Number(schedule.enabled),
          schedule.lastFireKey ?? null,
          new Date(schedule.nextFireAt).toISOString(),
        );

      if (!row) {
        throw new Error("Schedule was not saved. Restore storage.");
      }

      this.emitSchedule(txn, schedule, "saved");

      return rowToSchedule(row);
    });
  }

  async setScheduleEnabled({
    workspace,
    slug,
    enabled,
    nextFireAt,
  }: Parameters<Store["setScheduleEnabled"]>[0]): Promise<Schedule> {
    return this.commit((txn) => {
      const row = this.db
        .query<ScheduleRow, [number, string | null, string, string]>(SQL.setScheduleEnabled)
        .get(Number(enabled), nextFireAt ?? null, workspace, slug);

      if (!row) {
        throw new Error(`Schedule '${slug}' does not exist. Save the schedule before toggling it.`);
      }

      this.emitSchedule(txn, row, "saved");

      return rowToSchedule(row);
    });
  }

  async advanceSchedule(options: Parameters<Store["advanceSchedule"]>[0]): Promise<boolean> {
    return this.commit((txn) => {
      const { workspace, slug, version, nextFireAt } = options;

      const updated = this.db
        .query(SQL.advanceSchedule)
        .run(new Date(nextFireAt).toISOString(), workspace, slug, version);

      if (!updated.changes) {
        return false;
      }

      this.emitSchedule(txn, options, "saved");

      return true;
    });
  }

  async listSchedules(): Promise<Schedule[]> {
    return this.db.query<ScheduleRow, []>(SQL.schedules).all().map(rowToSchedule);
  }

  async deleteSchedule(workspace: string, slug: string): Promise<void> {
    this.commit((txn) => {
      const row = this.db.query<ScheduleRow, [string, string]>(SQL.schedule).get(workspace, slug);

      if (this.db.query(SQL.deleteSchedule).run(workspace, slug).changes && row) {
        const record = rowToSchedule(row);
        this.emit(txn, {
          entity: "schedule",
          kind: "deleted",
          runId: null,
          record: { workspace: record.workspace, slug: record.slug },
        });
      }
    });
  }

  async fireSchedule(options: Parameters<Store["fireSchedule"]>[0]): Promise<boolean> {
    return this.commit((txn) => {
      const { workspace, slug, version, fireKey, run, nextFireAt } = options;

      const schedule = this.db
        .query<ScheduleRow, [string, string]>(SQL.schedule)
        .get(workspace, slug);

      if (!schedule) {
        throw new Error(`Schedule '${slug}' does not exist. Save the schedule before firing it.`);
      }

      const updated = this.db
        .query(SQL.fireSchedule)
        .run(fireKey, new Date(nextFireAt).toISOString(), workspace, slug, version, fireKey);

      if (!updated.changes) {
        return false;
      }

      if (this.row(run.id)) {
        throw new Error(`Run '${run.id}' already exists. Use a new run ID.`);
      }

      this.insertRun(run);
      this.emitRun(txn, run.id, "created");
      this.emitSchedule(txn, schedule, "fired");

      return true;
    });
  }

  protected emitSchedule(
    txn: EventTransaction,
    schedule: Pick<Schedule, "workspace" | "slug">,
    kind: "saved" | "fired",
  ): void {
    const row = this.db
      .query<ScheduleRow, [string, string]>(SQL.schedule)
      .get(schedule.workspace, schedule.slug);

    if (!row) {
      throw new Error("Schedule disappeared before commit. Restore storage.");
    }

    this.emit(txn, { entity: "schedule", kind, runId: null, record: rowToSchedule(row) });
  }
}
