import { OwnershipError } from "../../core/index.js";
import { StoreRejectedError } from "../operation.js";
import { SqliteEvents } from "./events.js";
import { SQL } from "./store-rows.js";
import { type RunRow } from "./store-schema.js";

export class SqliteOwnership extends SqliteEvents {
  protected stale(row: RunRow, now: number): boolean {
    if (
      (row.status !== "running" && row.status !== "suspended") ||
      row.owner_token === null ||
      row.heartbeat_at === null
    ) {
      return false;
    }

    if (
      row.owner_host !== null &&
      this.options.owner.isAlive({ host: row.owner_host, pid: row.owner_pid })
    ) {
      return false;
    }

    return now - Date.parse(row.heartbeat_at) > this.leaseMs;
  }

  protected row(runId: string): RunRow | undefined {
    return this.db.query<RunRow, [string]>(SQL.run).get(runId) ?? undefined;
  }

  protected requireRow(runId: string): RunRow {
    const row = this.row(runId);

    if (!row) {
      throw new StoreRejectedError(`Run '${runId}' does not exist. Create the run first.`);
    }

    return row;
  }

  protected owned(runId: string, token: string): RunRow {
    const row = this.requireRow(runId);

    if (row.owner_token !== token) {
      throw new OwnershipError(runId);
    }

    return row;
  }

  protected requireRunning(row: RunRow): void {
    if (row.status !== "running") {
      throw new StoreRejectedError(
        `Run '${row.id}' cannot transition from '${row.status}'. Claim a queued or suspended run first.`,
      );
    }
  }
}
