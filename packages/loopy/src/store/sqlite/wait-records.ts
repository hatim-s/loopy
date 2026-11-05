import type { HookRecord, WaitRecord } from "../../core/index.js";
import type { EventTransaction } from "../event-outbox.js";
import { storageOperation } from "../operation.js";
import { storedDecoder } from "../row-codec.js";
import { utc } from "../timestamps.js";
import { publicHook } from "../wait.js";
import { waitRecordSchema } from "../wait-schema.js";
import { SqliteOwnership } from "./ownership.js";

const decodeWaitRecord = storedDecoder(waitRecordSchema, "waits");

export class SqliteWaitRecords extends SqliteOwnership {
  protected readWaits(runId: string): WaitRecord[] {
    return this.db
      .query<{ record: string }, [string]>("SELECT record FROM waits WHERE run_id=? ORDER BY rowid")
      .all(runId)
      .map((row) => decodeWaitRecord(row.record));
  }

  protected readHooks(runId: string): HookRecord[] {
    return this.readWaits(runId).map(publicHook);
  }

  getWaits(runId: string) {
    return storageOperation("getWaits", () => {
      return this.readWaits(runId);
    });
  }

  getWait(token: string) {
    return storageOperation("getWait", () => {
      return this.readWait(token);
    });
  }

  protected readWait(token: string): WaitRecord | undefined {
    const row = this.db
      .query<{ record: string }, [string]>("SELECT record FROM waits WHERE token=?")
      .get(token);

    return row ? decodeWaitRecord(row.record) : undefined;
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
