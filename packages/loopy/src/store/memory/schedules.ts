import type { Schedule } from "../../core";
import { type Store } from "../../core";
import { StoreRejectedError, storageOperation } from "../operation";
import { utc } from "../timestamps";
import { MemoryWaits } from "./waits";

export class MemorySchedules extends MemoryWaits {
  putSchedule(schedule: Omit<Schedule, "version">) {
    return storageOperation("putSchedule", () => {
      return this.commit((txn) => {
        const record = structuredClone({
          ...schedule,
          version:
            (this.schedules.get(JSON.stringify([schedule.workspace, schedule.slug]))?.version ??
              0) + 1,
          nextFireAt: utc(schedule.nextFireAt),
        });

        this.schedules.set(JSON.stringify([schedule.workspace, schedule.slug]), record);
        this.emit(txn, { entity: "schedule", kind: "saved", runId: null, record });

        return structuredClone(record);
      });
    });
  }

  setScheduleEnabled({
    workspace,
    slug,
    enabled,
    nextFireAt,
  }: Parameters<Store["setScheduleEnabled"]>[0]) {
    return storageOperation("setScheduleEnabled", () => {
      return this.commit((txn) => {
        const schedule = this.schedules.get(JSON.stringify([workspace, slug]));

        if (!schedule) {
          throw new StoreRejectedError(
            `Schedule '${slug}' does not exist. Save the schedule before toggling it.`,
          );
        }

        schedule.enabled = enabled;
        schedule.version += 1;

        if (nextFireAt !== undefined) {
          schedule.nextFireAt = utc(nextFireAt);
        }

        this.emit(txn, { entity: "schedule", kind: "saved", runId: null, record: schedule });

        return structuredClone(schedule);
      });
    });
  }

  advanceSchedule(options: Parameters<Store["advanceSchedule"]>[0]) {
    return storageOperation("advanceSchedule", () => {
      return this.commit((txn) => {
        const { workspace, slug, version, nextFireAt } = options;
        const schedule = this.schedules.get(JSON.stringify([workspace, slug]));

        if (!schedule || schedule.version !== version || !schedule.enabled) {
          return false;
        }

        schedule.nextFireAt = utc(nextFireAt);
        this.emit(txn, { entity: "schedule", kind: "saved", runId: null, record: schedule });

        return true;
      });
    });
  }

  scheduleOverview() {
    return storageOperation("scheduleOverview", () => {
      const schedules = [...this.schedules.values()];
      const active = schedules.filter((schedule) => schedule.enabled);

      return {
        workspaces: [...new Set(schedules.map((schedule) => schedule.workspace))].sort(),
        active: active.length,
        next: active
          .sort((a, b) => {
            for (const field of ["nextFireAt", "workspace", "slug"] as const) {
              if (a[field] !== b[field]) {
                return a[field] < b[field] ? -1 : 1;
              }
            }

            return 0;
          })
          .slice(0, 10)
          .map(({ workspace, slug, cron, tz, nextFireAt }) => ({
            workspace,
            slug,
            cron,
            tz,
            nextFireAt,
          })),
      };
    });
  }

  listSchedules() {
    return storageOperation("listSchedules", () => {
      return structuredClone([...this.schedules.values()]);
    });
  }

  deleteSchedule(workspace: string, slug: string) {
    return storageOperation("deleteSchedule", () => {
      return this.commit((txn) => {
        if (this.schedules.delete(JSON.stringify([workspace, slug]))) {
          this.emit(txn, {
            entity: "schedule",
            kind: "deleted",
            runId: null,
            record: { workspace, slug },
          });
        }
      });
    });
  }

  fireSchedule(options: Parameters<Store["fireSchedule"]>[0]) {
    return storageOperation("fireSchedule", () => {
      return this.commit((txn) => {
        const { workspace, slug, version, fireKey, run, nextFireAt } = options;
        const schedule = this.schedules.get(JSON.stringify([workspace, slug]));

        if (!schedule) {
          throw new StoreRejectedError(
            `Schedule '${slug}' does not exist. Save the schedule before firing it.`,
          );
        }

        if (schedule.lastFireKey === fireKey || schedule.version !== version || !schedule.enabled) {
          return false;
        }

        if (this.runs.has(run.id)) {
          throw new StoreRejectedError(`Run '${run.id}' already exists. Use a new run ID.`);
        }

        const savedRun = structuredClone(run);
        const next = utc(nextFireAt);
        this.runs.set(run.id, savedRun);
        schedule.lastFireKey = fireKey;
        schedule.nextFireAt = next;
        this.emit(txn, { entity: "run", kind: "created", runId: run.id, record: savedRun });
        this.emit(txn, { entity: "schedule", kind: "fired", runId: null, record: schedule });

        return true;
      });
    });
  }
}
