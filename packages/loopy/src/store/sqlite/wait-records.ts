import type { HookRecord, WaitRecord } from "../../core/index.js";
import type { EventTransaction } from "../event-outbox.js";
import { utc } from "../timestamps.js";
import { publicHook } from "../wait.js";
import { waitRecordSchema } from "../wait-schema.js";
import { SqliteOwnership } from "./ownership.js";

export class SqliteWaitRecords extends SqliteOwnership {
  protected readWaits(runId: string): WaitRecord[] {
    return this.db
      .query<{ record: string }, [string]>("SELECT record FROM waits WHERE run_id=? ORDER BY rowid")
      .all(runId)
      .map((row) => waitRecordSchema.parse(JSON.parse(row.record)));
  }

  protected readHooks(runId: string): HookRecord[] {
    return this.readWaits(runId).map(publicHook);
  }

  async getWaits(runId: string): Promise<WaitRecord[]> {
    return this.readWaits(runId);
  }

  async getWait(token: string): Promise<WaitRecord | undefined> {
    return this.readWait(token);
  }

  protected readWait(token: string): WaitRecord | undefined {
    const row = this.db
      .query<{ record: string }, [string]>("SELECT record FROM waits WHERE token=?")
      .get(token);

    return row ? waitRecordSchema.parse(JSON.parse(row.record)) : undefined;
  }

  protected writeWait(wait: WaitRecord): void {
    this.db.query("UPDATE waits SET record=? WHERE token=?").run(JSON.stringify(wait), wait.token);
  }

  protected expireWaits(txn: EventTransaction, runId: string, at: string): void {
    for (const wait of this.readWaits(runId)) {
      this.expireWait(txn, wait, at);
    }
  }

  protected expireWait(txn: EventTransaction, wait: WaitRecord, at: string): void {
    if (wait.resolvedAt || wait.expiredAt) {
      return;
    }

    const record = { ...wait, expiredAt: utc(at) };
    this.writeWait(record);
    this.emit(txn, {
      entity: "hook",
      kind: "expired",
      runId: wait.runId,
      record: publicHook(record),
    });
  }
}
