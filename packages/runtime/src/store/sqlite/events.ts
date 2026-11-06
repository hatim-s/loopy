import type { RuntimeEvent, RuntimeEventChange } from "@loopy/core";
import { EVENT_RETENTION, EventListeners, type EventTransaction } from "../event-outbox";
import { StoredDataError, storageOperation } from "../operation";
import { utc } from "../timestamps";
import type { SqlDriver } from "./driver";
import type { SqlStoreOptions } from "./owner-policy";
import { initializeSqlSchema } from "./schema";
import { rowToEvent, SQL } from "./store-rows";
import type { EventRow } from "./store-schema";

export class SqliteEvents {
  protected readonly now: () => number;

  get leaseMs(): number {
    return this.options.leaseMs ?? 60_000;
  }

  constructor(
    protected readonly db: SqlDriver,
    protected readonly options: SqlStoreOptions,
  ) {
    this.now = options.now ?? Date.now;
    initializeSqlSchema(db);
  }

  oldestEventSequence() {
    return storageOperation("oldestEventSequence", () => {
      return (
        this.db
          .query<{ oldest: number | null }, []>(
            "SELECT COALESCE(MIN(sequence), (SELECT seq + 1 FROM sqlite_sequence WHERE name='events')) AS oldest FROM events",
          )
          .get()?.oldest ?? undefined
      );
    });
  }

  protected readonly listeners = new EventListeners();

  subscribe(listener: (events: RuntimeEvent[]) => void): () => void {
    return this.listeners.subscribe(listener);
  }

  events(after: number, limit: number) {
    return storageOperation("events", () => {
      return this.db
        .query<EventRow, [number, number]>(SQL.events)
        .all(after, limit)
        .map(rowToEvent);
    });
  }

  transactionEvents(txn: string, after: number) {
    return storageOperation("transactionEvents", () => {
      return this.db
        .query<EventRow, [string, number]>(SQL.transactionEvents)
        .all(txn, after)
        .map(rowToEvent);
    });
  }

  epoch() {
    return storageOperation("epoch", () => {
      return this.readEpoch();
    });
  }

  protected readEpoch(): string {
    const row = this.db.query<{ value: string }, []>(SQL.epoch).get();

    if (!row) {
      throw new StoredDataError("Store epoch is missing. Recreate the database.");
    }

    return row.value;
  }

  protected readEventCursor() {
    return {
      cursor: this.db.query<{ cursor: number }, []>(SQL.cursor).get()?.cursor ?? 0,
      epoch: this.readEpoch(),
    };
  }

  eventCursor() {
    return storageOperation("eventCursor", () => {
      return this.db.transaction(() => this.readEventCursor(), "deferred");
    });
  }

  pruneEvents(now: string) {
    return storageOperation("pruneEvents", () => {
      const cutoff = new Date(Date.parse(now) - EVENT_RETENTION.maxAgeMs).toISOString();

      return this.db.query(SQL.pruneEvents).run(cutoff).changes;
    });
  }

  protected commit<T>(change: (txn: EventTransaction) => T): T {
    const txn: EventTransaction = { id: crypto.randomUUID(), events: [] };
    const result = this.db.transaction(() => change(txn), "immediate");

    this.listeners.publish(txn.events);

    return result;
  }

  protected emit(txn: EventTransaction, change: RuntimeEventChange): void {
    const row = this.db
      .query<
        EventRow,
        [
          string,
          string,
          string,
          string,
          string | null,
          string,
          string | null,
          string | null,
          string | null,
        ]
      >(SQL.appendEvent)
      .get(
        this.timestamp(),
        txn.id,
        change.entity,
        change.kind,
        change.runId,
        JSON.stringify(change.record),
        change.entity === "node"
          ? change.record.key.nodeId
          : change.entity === "log"
            ? (this.db
                .query<{ node_id: string }, [string, number]>(
                  "SELECT node_id FROM logs WHERE run_id=? AND seq=?",
                )
                .get(change.record.runId, change.record.seq)?.node_id ?? null)
            : null,
        change.entity === "run" || change.entity === "schedule" ? change.record.slug : null,
        change.entity === "run" || change.entity === "schedule" ? change.record.workspace : null,
      );

    if (!row) {
      throw new Error("Event was not appended. Restore storage.");
    }

    txn.events.push(rowToEvent(row));
  }

  close() {
    return storageOperation("close", () => this.db.close?.());
  }

  protected timestamp(): string {
    return utc(this.now());
  }
}
